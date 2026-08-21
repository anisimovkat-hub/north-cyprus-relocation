(() => {
  const leadEndpoint = 'https://script.google.com/macros/s/AKfycbwWgu7A8XVuX9UDfg1ZSYACqjkrHhPSq1aob7UQ6x6M0Tqp6HNzVf3yjAnzZ7Robvpy/exec';
  const metrikaId = 111319878;

  function reachGoal(goal, params) {
    if (typeof window.ym === 'function') window.ym(metrikaId, 'reachGoal', goal, params);
  }

  function buildPayload(form) {
    const values = Object.fromEntries(new FormData(form).entries());
    const params = new URLSearchParams(window.location.search);
    const messenger = values.preferred_messenger === 'Telegram'
      ? `${values.telegram_username || ''}; телефон: ${values.phone || ''}`
      : values.phone || '';
    return {
      ...values,
      messenger,
      source: `Статья: ${form.dataset.articleTitle || document.title}`,
      page: window.location.href,
      utm_source: params.get('utm_source') || '',
      utm_medium: params.get('utm_medium') || '',
      utm_campaign: params.get('utm_campaign') || ''
    };
  }

  document.querySelectorAll('.article-body').forEach((article, index) => {
    const articleTitle = article.closest('main')?.querySelector('h1')?.textContent.trim() || document.title;
    const checklistArticle = articleTitle.includes('Переезд на Северный Кипр в 2026');
    const heading = checklistArticle ? 'Получите полный чек-лист документов' : 'Обсудить ваш сценарий переезда';
    const description = checklistArticle
      ? 'Оставьте контакты — пришлём полную версию чек-листа со сроками годности документов и подскажем порядок первых шагов.'
      : 'Оставьте контакты — подскажем, какие шаги и документы важны именно в вашей ситуации.';
    const buttonLabel = checklistArticle ? 'Получить чек-лист и консультацию' : 'Получить консультацию';
    const prefix = `article-lead-${index + 1}`;
    const checklist = article.querySelector('#documents-checklist');
    (checklist || article).insertAdjacentHTML(checklist ? 'afterend' : 'beforeend', `
      <section class="article-lead" aria-labelledby="${prefix}-title">
        <h2 id="${prefix}-title">${heading}</h2>
        <p>${description}</p>
        <form class="article-lead-form" data-article-lead-form data-article-title="${articleTitle.replace(/&/g, '&amp;').replace(/"/g, '&quot;')}">
          <input type="hidden" name="lead_type" value="${checklistArticle ? 'Чек-лист документов из статьи' : 'Консультация из статьи'}">
          <div class="article-form-grid">
            <label for="${prefix}-name">Как к вам обращаться?<input id="${prefix}-name" name="name" type="text" autocomplete="name" required></label>
            <fieldset class="article-messenger"><legend>Куда вам написать?</legend><div class="article-messenger-options">
              <label class="article-messenger-option"><input type="radio" name="preferred_messenger" value="Telegram" required><span>Telegram</span></label>
              <label class="article-messenger-option"><input type="radio" name="preferred_messenger" value="WhatsApp" required><span>WhatsApp</span></label>
            </div></fieldset>
          </div>
          <div class="article-messenger-fields">
            <label data-telegram-field for="${prefix}-telegram" hidden>Username в Telegram<input id="${prefix}-telegram" name="telegram_username" type="text" placeholder="@username" disabled></label>
            <label data-phone-field for="${prefix}-phone" hidden><span data-phone-label>Телефон</span><input id="${prefix}-phone" name="phone" type="tel" placeholder="+7 999 000-00-00" autocomplete="tel" disabled></label>
          </div>
          <label class="article-form-consent"><input type="checkbox" required><span>Согласен на обработку данных и связь в выбранном мессенджере</span></label>
          <button class="btn" type="submit">${buttonLabel}</button>
          <div class="form-success" role="status" aria-live="polite"></div>
        </form>
      </section>`);
  });

  document.querySelectorAll('[data-article-lead-form]').forEach((form) => {
    const telegramField = form.querySelector('[data-telegram-field]');
    const telegramInput = telegramField?.querySelector('input');
    const phoneField = form.querySelector('[data-phone-field]');
    const phoneInput = phoneField?.querySelector('input');
    const phoneLabel = phoneField?.querySelector('[data-phone-label]');
    const success = form.querySelector('.form-success');

    function updateMessengerFields() {
      const choice = form.querySelector('input[name="preferred_messenger"]:checked')?.value || '';
      const telegramSelected = choice === 'Telegram';
      const phoneNeeded = choice === 'Telegram' || choice === 'WhatsApp';
      if (telegramField && telegramInput) {
        telegramField.hidden = !telegramSelected;
        telegramInput.disabled = !telegramSelected;
        telegramInput.required = telegramSelected;
      }
      if (phoneField && phoneInput) {
        phoneField.hidden = !phoneNeeded;
        phoneInput.disabled = !phoneNeeded;
        phoneInput.required = phoneNeeded;
      }
      if (phoneLabel) phoneLabel.textContent = telegramSelected ? 'Номер телефона' : 'Телефон для WhatsApp';
    }

    form.querySelectorAll('input[name="preferred_messenger"]').forEach((input) => input.addEventListener('change', updateMessengerFields));
    updateMessengerFields();

    form.addEventListener('submit', async (event) => {
      event.preventDefault();
      const submit = form.querySelector('button[type="submit"]');
      const initialLabel = submit?.textContent;
      if (submit) {
        submit.disabled = true;
        submit.textContent = 'Отправляем…';
      }
      try {
        await fetch(leadEndpoint, {
          method: 'POST',
          mode: 'no-cors',
          headers: { 'Content-Type': 'text/plain;charset=utf-8' },
          body: JSON.stringify(buildPayload(form)),
          keepalive: true
        });
        reachGoal('lead_form_sent', { form_source: 'article_form' });
        reachGoal('any_form_sent', { form_source: 'article_form' });
        form.reset();
        updateMessengerFields();
        if (success) {
          success.textContent = 'Заявка отправлена. Скоро свяжемся с вами в выбранном мессенджере.';
          success.classList.add('show');
        }
      } catch (error) {
        if (success) {
          success.textContent = 'Не удалось отправить заявку. Напишите нам в Telegram @zapasnoyaer или WhatsApp.';
          success.classList.add('show');
        }
      } finally {
        if (submit) {
          submit.disabled = false;
          submit.textContent = initialLabel;
        }
      }
    });
  });
})();
