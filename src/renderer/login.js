/**
 * src/renderer/login.js — login screen logic.
 */

(function () {
  const form = document.getElementById('login-form');
  const continueBtn = document.getElementById('continue-btn');
  const continueBtnText = document.getElementById('continue-btn-text');
  const saveCredsCheckbox = document.getElementById('saveCreds');
  const errorBanner = document.getElementById('error-banner');
  const errorBannerText = document.getElementById('error-banner-text');
  const errorBannerDismiss = document.getElementById('error-banner-dismiss');

  const fields = ['taiUser', 'taiPass', 'ctsiUser', 'ctsiPass'];

  function showError(message) {
    errorBannerText.textContent = message;
    errorBanner.classList.add('visible');
  }

  function hideError() {
    errorBanner.classList.remove('visible');
  }

  errorBannerDismiss.addEventListener('click', hideError);

  // Update button — same behavior as the main screen (see app.js).
  const updateBtn = document.getElementById('update-btn');
  function showUpdateButton(info) {
    if (!info || !info.version) return;
    updateBtn.textContent = `Update available — v${info.version}`;
    updateBtn.classList.remove('hidden');
  }
  updateBtn.addEventListener('click', () => window.boost.openDownloadPage());
  window.boost.onUpdateAvailable(showUpdateButton);
  window.boost.getUpdateStatus().then(showUpdateButton);

  // Password show/hide toggles.
  document.querySelectorAll('.toggle-visibility').forEach((btn) => {
    btn.addEventListener('click', () => {
      const targetId = btn.getAttribute('data-target');
      const input = document.getElementById(targetId);
      const isPassword = input.type === 'password';
      input.type = isPassword ? 'text' : 'password';
      btn.textContent = isPassword ? 'Hide' : 'Show';
    });
  });

  function clearFieldError(name) {
    const wrapper = document.getElementById(`field-${name}`);
    wrapper.classList.remove('has-error');
    document.getElementById(name).classList.remove('field-error');
  }

  function setFieldError(name) {
    const wrapper = document.getElementById(`field-${name}`);
    wrapper.classList.add('has-error');
    document.getElementById(name).classList.add('field-error');
  }

  function setBusy(busy) {
    continueBtn.disabled = busy;
    if (busy) {
      continueBtnText.innerHTML = '<span class="spinner"></span> Signing in&hellip;';
    } else {
      continueBtnText.textContent = 'Continue';
    }
  }

  // Note: no creds-based auto-skip here. main.js#createWindow already loads
  // main.html directly when hasCreds() is true, so login.html is only ever
  // shown when there are no persisted creds (LOW-11).

  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    hideError();

    const values = {};
    let valid = true;
    fields.forEach((name) => {
      const value = document.getElementById(name).value.trim();
      values[name] = value;
      if (!value) {
        setFieldError(name);
        valid = false;
      } else {
        clearFieldError(name);
      }
    });

    if (!valid) return;

    const creds = {
      taiUser: values.taiUser,
      taiPass: values.taiPass,
      ctsiUser: values.ctsiUser,
      ctsiPass: values.ctsiPass,
    };

    setBusy(true);
    try {
      if (saveCredsCheckbox.checked) {
        await window.boost.saveCreds(creds);
      } else {
        // Don't persist to disk. clearCreds also drops any prior session set;
        // then stash these creds in the main process for this session only
        // (survives the login->main navigation, unlike renderer sessionStorage).
        await window.boost.clearCreds();
        await window.boost.setSessionCreds(creds);
      }
      window.boost.navigate('main');
    } catch (err) {
      setBusy(false);
      showError(err && err.message ? err.message : 'Could not save login details.');
    }
  });
})();
