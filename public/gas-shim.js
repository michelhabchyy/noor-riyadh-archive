/**
 * gas-shim.js — drop-in replacement for Google Apps Script's google.script.run.
 *
 * Your index.html calls e.g.:
 *   google.script.run.withSuccessHandler(fn).withFailureHandler(fn).getData();
 * This shim recreates that exact chainable API, but each method POSTs to a
 * matching /api/<method> route on this server and resolves with the response
 * text (the routes return JSON strings, just like Apps Script did).
 *
 * Load this BEFORE the inline <script> in index.html.
 */
(function () {
  var METHODS = ['getData', 'askAI', 'coversFor', 'listFolder'];

  function Runner(cfg) { this.cfg = cfg || {}; }
  Runner.prototype.withSuccessHandler = function (fn) {
    return new Runner(Object.assign({}, this.cfg, { success: fn }));
  };
  Runner.prototype.withFailureHandler = function (fn) {
    return new Runner(Object.assign({}, this.cfg, { failure: fn }));
  };
  Runner.prototype.withUserObject = function (obj) {
    return new Runner(Object.assign({}, this.cfg, { userObject: obj }));
  };

  METHODS.forEach(function (m) {
    Runner.prototype[m] = function () {
      var args = Array.prototype.slice.call(arguments);
      var cfg = this.cfg;
      fetch('/api/' + m, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ args: args })
      })
        .then(function (r) {
          if (!r.ok) {
            return r.text().then(function (t) {
              var msg = t;
              try { msg = JSON.parse(t).message || t; } catch (e) {}
              throw new Error(msg || ('HTTP ' + r.status));
            });
          }
          return r.text();
        })
        .then(function (text) {
          if (cfg.success) cfg.success(text, cfg.userObject);
        })
        .catch(function (err) {
          if (cfg.failure) cfg.failure(err, cfg.userObject);
          else console.error('google.script.run error:', err);
        });
      return this;
    };
  });

  window.google = window.google || {};
  window.google.script = window.google.script || {};
  window.google.script.run = new Runner();
})();
