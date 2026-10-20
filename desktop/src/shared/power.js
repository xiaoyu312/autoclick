'use strict';

class PowerBlockerController {
  constructor(api) {
    if (!api || typeof api.start !== 'function' || typeof api.stop !== 'function') {
      throw new TypeError('power blocker API must expose start and stop');
    }
    this.api = api;
    this.id = null;
  }

  acquire() {
    if (this.id !== null) return this.id;
    this.id = this.api.start('prevent-app-suspension');
    return this.id;
  }

  release() {
    if (this.id === null) return false;
    const id = this.id;
    this.id = null;
    this.api.stop(id);
    return true;
  }

  get held() {
    return this.id !== null;
  }
}

module.exports = { PowerBlockerController };
