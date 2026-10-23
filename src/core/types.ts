export type Platform = 'instagram';

export interface CommentKeywordTrigger {
  type: 'comment_keyword';
  keyword: string;
  post_ids: string[] | null;
}

export type Trigger = CommentKeywordTrigger;

export interface ReplyToCommentStep {
  type: 'reply_to_comment';
  text: string;
}

export interface SendDmStep {
  type: 'send_dm';
  text: string;
}

export interface WaitForReplyStep {
  type: 'wait_for_reply';
  validator: 'email';
  save_as: string;
  timeout_seconds: number;
  max_reprompts: number;
  reprompt_text: string;
  give_up_text: string;
}

export type Step = ReplyToCommentStep | SendDmStep | WaitForReplyStep;
export type StepType = Step['type'];

// Variables every comment trigger puts into the run context for templating.
export const TRIGGER_VARS = ['username', 'comment_text'] as const;

export interface ContactKey {
  accountId: string;
  platform: Platform;
  contactId: string;
}
