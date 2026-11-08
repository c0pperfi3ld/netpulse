'use strict';
/**
 * Link layer + IP config + ISP identity.
 *
 * getAdapters() reads the NIC list as JSON from PowerShell (one-shot, cached by
 * the caller). The interesting field is LinkSpeed: a Gigabit NIC that negotiated
 * 100 Mbps points at a 2-pair/damaged cable or a Fast-Ethernet port, which caps
 * upload and all LAN traffic long before the ISP is involved.
 */
const https = require('node:https');
const { run, IS_WIN } = require('../util/proc');
const { ENDPOINTS } = require('../../shared/constants');

const VIRTUAL = /virtual|vmware|vbox|virtualbox|hyper-v|loopback|bluetooth|tap|wintun|zerotier|tailscale/i;
const GIGABIT_CAPABLE = /gbe|gigabit|gigabit\s*ethernet|i21[0-9]|i22[0-9]|rtl81|realtek pcie gbe|killer|intel\(r\) ethernet/i;

async function getAdapters() {
  const ps = [
    'Get-NetAdapter',
    '|',
    'Select-Object Name,InterfaceDescription,Status,LinkSpeed,MacAddress,MediaType,ifIndex,Virtual',
    '|',
    'ConvertTo-Json -Compress',
  ].join(' ');
  const { stdout, spawnError } = await run('powershell', ['-NoProfile', '-Command', ps], { timeoutMs: 20_000 });
  if (spawnError) return { adapters: [], error: 'powershell unavailable' };
  try {
    const parsed = JSON.parse(stdout.trim() || '[]');
    const list = Array.isArray(parsed) ? parsed : [parsed];
    return { adapters: list.map(normalizeAdapter) };
  } catch (e) {
    return { adapters: [], error: `parse failed: ${e.message}` };
  }
}

function normalizeAdapter(a) {
  const speedMbps = parseLinkSpeed(a.LinkSpeed);
  const desc = a.InterfaceDescription || '';
  const virtual = Boolean(a.Virtual) || VIRTUAL.test(desc) || VIRTUAL.test(a.Name || '');
  const gigabitCapable = GIGABIT_CAPABLE.test(desc);
  return {
    name: a.Name,
    description: desc,
    status: a.Status,
    linkSpeedMbps: speedMbps,
    linkSpeed: a.LinkSpeed,
    mac: a.MacAddress,
    mediaType: a.MediaType,
    ifIndex: a.ifIndex,
    virtual,
    gigabitCapable,
    // The actionable flag: hardware can do 1 Gbps but negotiated 100 Mbps.
    linkBottleneck: !virtual && gigabitCapable && speedMbps != null && speedMbps <= 100,
  };
}

function parseLinkSpeed(s) {
  if (!s) return null;
  const m = /([\d.]+)\s*(G|M)bps/i.exec(String(s));
  if (!m) return null;
  const v = Number(m[1]);
  return m[2].toUpperCase() === 'G' ? v * 1000 : v;
}

/** Primary physical interface = first non-virtual adapter that is Up. */
function pickPrimary(adapters) {
  const up = adapters.filter((a) => a.status === 'Up' && !a.virtual);
  if (!up.length) return null;
  return up.sort((a, b) => (b.linkSpeedMbps || 0) - (a.linkSpeedMbps || 0))[0];
}

function parseNetshConfig(text) {
  const out = { dhcp: null, addresses: [], gateways: [], dns: [], dnsFromDhcp: false };
  const lines = String(text).split(/\r?\n/);
  let dnsMode = null;
  for (const raw of lines) {
    const line = raw.trim();
    if (/^DHCP enabled:\s*Yes/i.test(line)) out.dhcp = true;
    else if (/^DHCP enabled:\s*No/i.test(line)) out.dhcp = false;
    const ip = /^IP Address:\s*([\d.]+)/i.exec(line);
    if (ip) out.addresses.push(ip[1]);
    const gw = /^Default Gateway:\s*([\d.]+)/i.exec(line);
    if (gw) out.gateways.push(gw[1]);
    if (/^DNS servers configured through DHCP:\s*(.+)/i.test(line)) {
      dnsMode = 'dhcp';
      const ipv4 = /(\d+\.\d+\.\d+\.\d+)/.exec(line);
      if (ipv4) out.dns.push(ipv4[1]);
    } else if (/^Statically Configured DNS Servers:\s*(.+)/i.test(line)) {
      dnsMode = 'static';
      const ipv4 = /(\d+\.\d+\.\d+\.\d+)/.exec(line);
      if (ipv4) out.dns.push(ipv4[1]);
    } else if (dnsMode && /^\s*(\d+\.\d+\.\d+\.\d+)\s*$/.test(line)) {
      out.dns.push(line.trim());
    }
  }
  out.dnsFromDhcp = dnsMode === 'dhcp';
  out.dns = [...new Set(out.dns)];
  return out;
}

async function getIpConfig(ifaceName) {
  const { stdout } = await run('netsh', ['interface', 'ipv4', 'show', 'config', `name=${ifaceName}`], {
    timeoutMs: 10_000,
  });
  return parseNetshConfig(stdout);
}

async function getMacAddress(ifaceName) {
  const { stdout } = await run('netsh', ['interface', 'ipv4', 'show', 'config', `name=${ifaceName}`], {
    timeoutMs: 8000,
  });
  const m = /Physical Address:\s*([0-9A-Fa-f-]+)/.exec(stdout);
  return m ? m[1] : null;
}

/** One full link snapshot, used by the diagnostics view and quality scoring. */
async function linkSnapshot({ ifaceName } = {}) {
  const { adapters, error } = await getAdapters();
  const primary = pickPrimary(adapters);
  const iface = ifaceName || (primary ? primary.name : null);
  const [ip, mac] = iface
    ? await Promise.all([getIpConfig(iface).catch(() => null), getMacAddress(iface).catch(() => null)])
    : [null, null];
  const issues = [];
  if (primary && primary.linkBottleneck) {
    issues.push({
      severity: 'warn',
      code: 'link-negotiation',
      title: `${primary.name} negotiated ${primary.linkSpeed} on Gigabit hardware`,
      detail:
        'A damaged or 2-pair cable, or a Fast-Ethernet router port, caps the link at 100 Mbps. This limits upload and all LAN transfers regardless of the ISP plan.',
    });
  }
  return {
    adapters,
    error,
    interface: iface,
    primary: primary || null,
    linkSpeedMbps: primary ? primary.linkSpeedMbps : null,
    ip: ip || null,
    mac,
    issues,
  };
}

function fetchJson(url, timeoutMs = 6000) {
  return new Promise((resolve) => {
    const req = https.get(url, { timeout: timeoutMs, headers: { 'user-agent': 'netpulse/1.0' } }, (res) => {
      let body = '';
      res.on('data', (d) => (body += d));
      res.on('end', () => {
        try {
          resolve({ ok: true, data: JSON.parse(body) });
        } catch (e) {
          resolve({ ok: false, error: `bad json: ${e.message}` });
        }
      });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ ok: false, error: 'timeout' });
    });
    req.on('error', (e) => resolve({ ok: false, error: String(e.message || e) }));
  });
}

async function ispIdentity() {
  const r = await fetchJson(ENDPOINTS.ipinfo);
  if (!r.ok) return { ok: false, error: r.error };
  const d = r.data || {};
  return {
    ok: true,
    ip: d.ip,
    hostname: d.hostname,
    org: d.org,
    asn: d.org && d.org.startsWith('AS') ? d.org.split(' ')[0] : null,
    city: d.city,
    region: d.region,
    country: d.country,
    timezone: d.timezone,
  };
}

/** IPv6 reachability, kept separate because partial v6 is common and confusing. */
function ipv6Check(timeoutMs = 6000) {
  return new Promise((resolve) => {
    const req = https.get('https://ipv6.google.com/generate_204', { timeout: timeoutMs, family: 6 }, (res) => {
      res.resume();
      resolve({ available: true, status: res.statusCode });
    });
    req.on('timeout', () => {
      req.destroy();
      resolve({ available: false, error: 'timeout' });
    });
    req.on('error', (e) => resolve({ available: false, error: String(e.code || e.message) }));
  });
}

module.exports = {
  getAdapters,
  getIpConfig,
  linkSnapshot,
  ispIdentity,
  ipv6Check,
  parseLinkSpeed,
  parseNetshConfig,
  pickPrimary,
  IS_WIN,
};
