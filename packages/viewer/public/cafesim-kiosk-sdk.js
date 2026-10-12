/*!
 * cafeSim kiosk SDK - talk to the simulated machine from any web page shown on the
 * M400 touch screen (the page runs inside the viewer's iframe; any origin works).
 *
 *   <script src="https://<viewer>/cafesim-kiosk-sdk.js"></script>
 *   const menu = await CafeSim.getMenu();
 *   CafeSim.on('step',  (s) => console.log(s.text));   // production progress
 *   CafeSim.on('guide', (prompts) => ...);              // what the customer must do now
 *   await CafeSim.pay(2000);                             // KSCAT card approval
 *   await CafeSim.order('americano', 'ice');             // cup -> ice -> drink -> pickup
 */
(function () {
  var pending = {};
  var handlers = {};
  var seq = 0;
  var host = window.parent !== window ? window.parent : window.opener;

  window.addEventListener('message', function (e) {
    var m = e.data;
    if (!m || !m.cafesim) return;
    if (m.cafesim === 'result' && pending[m.id]) {
      var p = pending[m.id];
      delete pending[m.id];
      if (m.error) p.reject(new Error(m.error));
      else p.resolve(m.result);
    } else if (m.cafesim === 'event') {
      (handlers[m.type] || []).slice().forEach(function (fn) {
        fn(m.data);
      });
    }
  });

  function call(method) {
    var args = Array.prototype.slice.call(arguments, 1);
    return new Promise(function (resolve, reject) {
      if (!host) return reject(new Error('cafeSim viewer not found (open this page inside the simulator)'));
      var id = ++seq;
      pending[id] = { resolve: resolve, reject: reject };
      host.postMessage({ cafesim: 'call', id: id, method: method, args: args }, '*');
    });
  }

  window.CafeSim = {
    available: !!host,
    call: call,
    on: function (type, fn) {
      (handlers[type] = handlers[type] || []).push(fn);
      return function () {
        handlers[type] = (handlers[type] || []).filter(function (f) {
          return f !== fn;
        });
      };
    },
    getPlatform: function () {
      return call('getPlatform');
    },
    getMenu: function () {
      return call('getMenu');
    },
    getState: function () {
      return call('getState');
    },
    init: function () {
      return call('init');
    },
    pay: function (amount) {
      return call('pay', amount);
    },
    cancelPayment: function () {
      return call('cancelPayment');
    },
    order: function (itemId, temp) {
      return call('order', itemId, temp);
    },
  };
})();
