(() => {
  'use strict';

  const leadEndpoint = 'https://script.google.com/macros/s/AKfycbwWgu7A8XVuX9UDfg1ZSYACqjkrHhPSq1aob7UQ6x6M0Tqp6HNzVf3yjAnzZ7Robvpy/exec';
  const metrikaId = 111319878;
  const form = document.querySelector('[data-guide-lead-form]');
  const access = document.querySelector('[data-guide-access]');
  const status = document.querySelector('[data-guide-form-status]');
  const phoneInput = form?.querySelector('[data-phone-input]');
  let phoneControl = null;
  let phoneUtilsReady = false;
  let phoneReady = Promise.resolve();

  if (!form || !access) return;

  if (phoneInput && typeof window.intlTelInput === 'function') {
    phoneControl = window.intlTelInput(phoneInput, {
      initialCountry: 'ru',
      countryOrder: ['ru', 'cy', 'tr', 'kz', 'by', 'ge', 'am', 'ae'],
      countryNameLocale: 'ru',
      separateDialCode: true,
      strictMode: true,
      uiTranslations: {
        selectedCountryAriaLabel: 'Изменить страну для номера телефона, выбрана ${countryName} (${dialCode})',
        noCountrySelected: 'Выберите страну для номера телефона',
        countryListAriaLabel: 'Список стран',
        searchPlaceholder: 'Поиск страны',
        clearSearchAriaLabel: 'Очистить поиск',
        searchEmptyState: 'Страна не найдена',
        searchSummaryAria: (count) => `Найдено стран: ${count}`
      },
      loadUtils: () => import('/assets/vendor/intl-tel-input/js/utils.js?v=29.2.3')
    });

    phoneReady = phoneControl.promise
      .then(() => {
        phoneUtilsReady = true;
      })
      .catch(() => {
        phoneUtilsReady = false;
      });
  }

  function reachGoal(goal, params) {
    if (typeof window.ym === 'function') {
      window.ym(metrikaId, 'reachGoal', goal, params);
    }
  }

  function clearPhoneError() {
    if (!phoneInput) return;
    phoneInput.setCustomValidity('');
    phoneInput.removeAttribute('aria-invalid');
    if (status?.dataset.phoneError === 'true') {
      status.textContent = '';
      delete status.dataset.phoneError;
    }
  }

  function getPhoneErrorMessage(errorCode) {
    const errors = window.intlTelInput?.VALIDATION_ERROR;

    if (errorCode === errors?.INVALID_COUNTRY_CODE) {
      return 'Выберите страну и проверьте международный код.';
    }
    if (errorCode === errors?.TOO_SHORT) {
      return 'В номере не хватает цифр. Введите номер полностью.';
    }
    if (errorCode === errors?.TOO_LONG) {
      return 'В номере слишком много цифр. Проверьте номер.';
    }
    return 'Проверьте номер телефона для выбранной страны.';
  }

  function validatePhone() {
    if (!phoneInput || !phoneInput.value.trim()) {
      return { valid: false, message: 'Введите номер телефона.' };
    }
    if (!phoneControl || !phoneUtilsReady) {
      return { valid: false, message: 'Проверка номера ещё загружается. Повторите через несколько секунд.' };
    }
    if (!phoneControl.isValidNumber()) {
      return {
        valid: false,
        message: getPhoneErrorMessage(phoneControl.getValidationError())
      };
    }

    const country = phoneControl.getSelectedCountry();
    return {
      valid: true,
      e164: phoneControl.getNumber(),
      country: country?.iso2?.toUpperCase() || '',
      dialCode: country?.dialCode ? `+${country.dialCode}` : ''
    };
  }

  function showPhoneError(message) {
    if (!phoneInput) return;
    phoneInput.setCustomValidity(message);
    phoneInput.setAttribute('aria-invalid', 'true');
    phoneInput.reportValidity();
    phoneInput.focus();
    if (status) {
      status.textContent = message;
      status.dataset.phoneError = 'true';
    }
  }

  function buildPayload(phone) {
    const values = Object.fromEntries(new FormData(form).entries());
    const params = new URLSearchParams(window.location.search);

    return {
      ...values,
      phone: phone.e164,
      messenger: phone.e164,
      phone_country: phone.country,
      phone_country_code: phone.dialCode,
      source: form.dataset.leadSource || 'Лид-магнит (форма)',
      page: window.location.href,
      utm_source: params.get('utm_source') || '',
      utm_medium: params.get('utm_medium') || '',
      utm_campaign: params.get('utm_campaign') || ''
    };
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

    await phoneReady;
    const phone = validatePhone();
    if (!phone.valid) {
      showPhoneError(phone.message);
      return;
    }
    clearPhoneError();

    const submit = form.querySelector('button[type="submit"]');
    const initialLabel = submit?.textContent;

    if (submit) {
      submit.disabled = true;
      submit.textContent = 'Открываем доступ…';
    }
    if (status) status.textContent = '';

    try {
      await fetch(leadEndpoint, {
        method: 'POST',
        mode: 'no-cors',
        headers: { 'Content-Type': 'text/plain;charset=utf-8' },
        body: JSON.stringify(buildPayload(phone)),
        keepalive: true
      });

      const goalParams = {
        form_source: form.dataset.formSource || 'guide_form',
        guide: form.dataset.guide || 'lead_magnet'
      };
      reachGoal('lead_form_sent', goalParams);
      reachGoal('any_form_sent', goalParams);
      if (form.dataset.goal) reachGoal(form.dataset.goal, goalParams);

      form.hidden = true;
      access.hidden = false;
      access.focus();
    } catch (error) {
      if (status) {
        const fallbackUrl = form.dataset.fallbackUrl;
        status.innerHTML = fallbackUrl
          ? 'Не удалось отправить форму. Попробуйте ещё раз или <a href="' + fallbackUrl + '" target="_blank" rel="noopener noreferrer">заберите гайд в Telegram</a>.'
          : 'Не удалось отправить форму. Проверьте соединение и попробуйте ещё раз.';
      }
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = initialLabel;
      }
    }
  });

  phoneInput?.addEventListener('input', clearPhoneError);
  phoneInput?.addEventListener('countrychange', clearPhoneError);
})();
