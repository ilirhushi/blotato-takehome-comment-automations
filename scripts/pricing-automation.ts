export const pricingTrigger = { type: 'comment_keyword', keyword: 'pricing', post_ids: null };

export const pricingSteps = [
  { type: 'reply_to_comment', text: 'Sent you a DM!' },
  { type: 'send_dm', text: 'Hi {{username}}! What email should we send pricing to?' },
  {
    type: 'wait_for_reply',
    validator: 'email',
    save_as: 'email',
    timeout_seconds: 24 * 60 * 60,
    max_reprompts: 2,
    reprompt_text: "Hmm, that doesn't look like an email. Could you double-check it?",
    give_up_text: 'No worries! Comment "pricing" again any time.',
  },
  { type: 'send_dm', text: 'Thanks! Here is our pricing: https://example.com/pricing (copy sent to {{email}})' },
];
