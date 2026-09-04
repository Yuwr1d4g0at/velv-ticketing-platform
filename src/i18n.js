// Minimal hand-rolled i18n for the public-facing pages only (request form,
// status/reply, CSAT rating) - scoped there deliberately, not the whole app
// (the dashboard stays English-only for now). A dictionary + t(lang, key)
// rather than a library: the string set is small and fixed, and every other
// cross-cutting concern in this app (CSRF, sessions, CSV) is hand-rolled the
// same way rather than reaching for a dependency.
const STRINGS = {
  en: {
    // Header nav (public pages only - the dashboard stays English-only)
    nav_submit_request: "Submit a request",
    nav_check_status: "Check status",
    nav_helpdesk_login: "Helpdesk login",
    // Request form
    submit_request_title: "Submit a request",
    submit_request_intro: "Tell us what's going on and we'll get back to you. You'll get a ticket number to track its status.",
    your_details: "Your details",
    your_name: "Your name",
    your_email: "Your email",
    category: "Category",
    choose_one: "Choose one…",
    related_asset: "Related asset (optional)",
    not_asset_specific: "Not asset-specific",
    whats_going_on: "What's going on",
    subject: "Subject",
    description: "Description",
    attachments: "Attachments",
    submit_request_button: "Submit request",
    // Validation errors
    err_name_required: "Your name is required.",
    err_email_invalid: "A valid email address is required.",
    err_category_invalid: "Please choose a valid category.",
    err_subject_required: "A subject is required.",
    err_description_required: "A description is required.",
    err_subject_too_long: "Subject must be under 200 characters.",
    err_description_too_long: "Description must be under 5000 characters.",
    err_asset_invalid: "Please choose a valid asset.",
    // Status check
    check_status_title: "Check ticket status",
    check_status_intro: "Enter your ticket number and the email address you used to submit it.",
    ticket_number: "Ticket number",
    email_used: "Email used to submit it",
    check_status_button: "Check status",
    err_status_missing_fields: "Enter both your ticket number and the email you used to submit it.",
    err_status_not_found: "No matching ticket found. Check the ticket number and email address.",
    ticket_hash: "Ticket #",
    priority: "Priority",
    status: "Status",
    submitted: "Submitted",
    last_updated: "Last updated",
    conversation: "Conversation",
    no_replies_yet: "No replies yet.",
    add_a_reply: "Add a reply",
    reply_placeholder: "Ask a follow-up question or add more detail…",
    reply_reopens_hint: "Replying to a Resolved or Closed ticket reopens it.",
    send_reply_button: "Send reply",
    err_reply_empty: "Enter a message before sending.",
    you: "You",
    // Category display labels (stored value in the DB stays the fixed
    // English constant - see CATEGORY_LABELS below)
  },
  pt: {
    nav_submit_request: "Enviar um pedido",
    nav_check_status: "Consultar estado",
    nav_helpdesk_login: "Acesso da equipa",
    submit_request_title: "Enviar um pedido",
    submit_request_intro: "Diga-nos o que se passa e entraremos em contacto. Vai receber um número de ticket para acompanhar o estado.",
    your_details: "Os seus dados",
    your_name: "O seu nome",
    your_email: "O seu email",
    category: "Categoria",
    choose_one: "Escolha uma opção…",
    related_asset: "Ativo relacionado (opcional)",
    not_asset_specific: "Não é sobre um ativo específico",
    whats_going_on: "O que se passa",
    subject: "Assunto",
    description: "Descrição",
    attachments: "Anexos",
    submit_request_button: "Enviar pedido",
    err_name_required: "O nome é obrigatório.",
    err_email_invalid: "É necessário um endereço de email válido.",
    err_category_invalid: "Escolha uma categoria válida.",
    err_subject_required: "O assunto é obrigatório.",
    err_description_required: "A descrição é obrigatória.",
    err_subject_too_long: "O assunto deve ter menos de 200 caracteres.",
    err_description_too_long: "A descrição deve ter menos de 5000 caracteres.",
    err_asset_invalid: "Escolha um ativo válido.",
    check_status_title: "Consultar estado do ticket",
    check_status_intro: "Indique o número do ticket e o email que usou para o submeter.",
    ticket_number: "Número do ticket",
    email_used: "Email usado para submeter",
    check_status_button: "Consultar estado",
    err_status_missing_fields: "Indique o número do ticket e o email que usou.",
    err_status_not_found: "Nenhum ticket encontrado. Verifique o número do ticket e o email.",
    ticket_hash: "Ticket #",
    priority: "Prioridade",
    status: "Estado",
    submitted: "Submetido",
    last_updated: "Última atualização",
    conversation: "Conversa",
    no_replies_yet: "Ainda sem respostas.",
    add_a_reply: "Adicionar uma resposta",
    reply_placeholder: "Faça uma pergunta de seguimento ou acrescente mais detalhe…",
    reply_reopens_hint: "Responder a um ticket Resolvido ou Fechado reabre-o.",
    send_reply_button: "Enviar resposta",
    err_reply_empty: "Escreva uma mensagem antes de enviar.",
    you: "Você",
  },
};

// The stored category value (tickets.category) is always the fixed English
// constant from src/constants.js, regardless of display language - only the
// public-facing label changes, so dashboard filtering/reporting never has
// to deal with a category stored in two different languages.
const CATEGORY_LABELS = {
  en: { Hardware: "Hardware", Software: "Software", Network: "Network", "Account & Access": "Account & Access", Other: "Other" },
  pt: { Hardware: "Hardware", Software: "Software", Network: "Rede", "Account & Access": "Conta e Acesso", Other: "Outro" },
};

const LANGUAGES = Object.keys(STRINGS);

function t(lang, key) {
  return (STRINGS[lang] && STRINGS[lang][key]) || STRINGS.en[key] || key;
}

function categoryLabel(lang, category) {
  return (CATEGORY_LABELS[lang] && CATEGORY_LABELS[lang][category]) || category;
}

module.exports = { t, categoryLabel, LANGUAGES };
