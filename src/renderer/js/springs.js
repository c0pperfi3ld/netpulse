'use strict';
/* Spring physics for readouts. One integrator, no dependency, and a global
   intensity scaler so the Settings slider can dial motion down to zero. */
(function () {
  const NP = (window.NP = window.NP || {});
  NP.motion = { intensity: 0.7, reduced: false };

  const scale = () => (NP.motion.reduced ? 0 : NP.motion.intensity);

  class Spring {
    constructor(value = 0, { stiffness = 120, damping = 18, mass = 1 } = {}) {
      this.value = value;
      this.target = value;
      this.velocity = 0;
      this.k = stiffness;
      this.c = damping;
      this.mass = mass;
    }

    set(target) {
      this.target = target;
    }
    snap(v) {
      this.value = v;
      this.target = v;
      this.velocity = 0;
    }
    /** Integrate one step; returns the new value. */
    step(dtMs) {
      const s = scale();
      if (s === 0) {
        this.value = this.target;
        this.velocity = 0;
        return this.value;
      }
      const dt = Math.min(0.05, (dtMs / 1000) * (0.4 + 0.6 * s));
      const f = -this.k * (this.value - this.target) - this.c * this.velocity;
      this.velocity += (f / this.mass) * dt;
      this.value += this.velocity * dt;
      if (Math.abs(this.value - this.target) < 1e-4 && Math.abs(this.velocity) < 1e-3) {
        this.value = this.target;
        this.velocity = 0;
      }
      return this.value;
    }
    settled() {
      return Math.abs(this.value - this.target) < 1e-3 && Math.abs(this.velocity) < 1e-3;
    }
  }

  /** Text element driven by a spring, formatted on every frame. */
  class SpringText {
    constructor(node, value = 0, format = (v) => String(Math.round(v))) {
      this.node = node;
      this.spring = new Spring(value);
      this.format = format;
      this.lastText = null;
    }
    set(target) {
      this.spring.set(target);
    }
    snap(v) {
      this.spring.snap(v);
    }
    tick(dt) {
      const v = this.spring.step(dt);
      const text = this.format(v);
      if (text !== this.lastText) {
        this.node.textContent = text;
        this.lastText = text;
      }
      return v;
    }
  }

  const ease = {
    outCubic: (t) => 1 - (1 - t) ** 3,
    outBack: (t) => 1 + 2.7 * (t - 1) ** 3 + 1.7 * (t - 1) ** 2,
  };

  Object.assign(NP, { Spring, SpringText, ease, motionScale: scale });
})();
