(() => {
  'use strict';

  const leadEndpoint = 'https://script.google.com/macros/s/AKfycbwWgu7A8XVuX9UDfg1ZSYACqjkrHhPSq1aob7UQ6x6M0Tqp6HNzVf3yjAnzZ7Robvpy/exec';
  const metrikaId = 111319878;
  const form = document.querySelector('[data-guide-lead-form]');
  const access = document.querySelector('[data-guide-access]');
  const status = document.querySelector('[data-guide-form-status]');

  if (!form || !access) return;

  function reachGoal(goal, params) {
    if (typeof window.ym === 'function') {
      window.ym(metrikaId, 'reachGoal', goal, params);
    }
  }

  function buildPayload() {
    const values = Object.fromEntries(new FormData(form).entries());
    const params = new URLSearchParams(window.location.search);

    return {
      ...values,
      messenger: values.phone || '',
      source: 'Лид-магнит: релокация команды (форма)',
      page: window.location.href,
      utm_source: params.get('utm_source') || '',
      utm_medium: params.get('utm_medium') || '',
      utm_campaign: params.get('utm_campaign') || ''
    };
  }

  form.addEventListener('submit', async (event) => {
    event.preventDefault();

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
        body: JSON.stringify(buildPayload()),
        keepalive: true
      });

      const goalParams = {
        form_source: 'guide_team_relocation_form',
        guide: 'team_relocation'
      };
      reachGoal('lead_form_sent', goalParams);
      reachGoal('any_form_sent', goalParams);
      reachGoal('guide_team_relocation_form_sent', goalParams);

      form.hidden = true;
      access.hidden = false;
      access.focus();
    } catch (error) {
      if (status) {
        status.innerHTML = 'Не удалось отправить форму. Попробуйте ещё раз или <a href="https://t.me/zapasnoyaero/119" target="_blank" rel="noopener noreferrer">заберите гайд в Telegram</a>.';
      }
    } finally {
      if (submit) {
        submit.disabled = false;
        submit.textContent = initialLabel;
      }
    }
  });
})();
