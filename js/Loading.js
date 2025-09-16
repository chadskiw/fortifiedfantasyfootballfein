// /js/Loading.js
(function () {
  const el = document.getElementById('loadingOverlay');
  const msgEl = el?.querySelector('#loadingMsg');

  const Loading = {
    show(message = 'Loading…') {
      if (msgEl) msgEl.textContent = message;
      el?.classList.add('active');
      el?.setAttribute('aria-hidden', 'false');
    },
    hide() {
      el?.classList.remove('active');
      el?.setAttribute('aria-hidden', 'true');
    },
    set(message = 'Loading…') {
      if (msgEl) msgEl.textContent = message;
    },
    async wrap(promiseOrFn, message = 'Loading…') {
      try {
        this.show(message);
        const p = (typeof promiseOrFn === 'function') ? promiseOrFn() : promiseOrFn;
        return await p;
      } finally {
        this.hide();
      }
    }
  };

  window.Loading = Loading;
})();
