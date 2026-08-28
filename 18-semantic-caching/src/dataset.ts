/**
 * Authored support-desk dataset for a fictional developer platform. Every
 * intent carries a canonical phrasing, filler-wrapped trivial variants,
 * genuine paraphrases, and the answer the model would give. Intents come in
 * families whose siblings share surface phrasing but differ in one critical
 * slot (reset password vs reset api key, enable vs disable 2fa) — the pairs
 * a similarity cache is most tempted to confuse. Everything here is
 * hand-written, no model produced any of it.
 */

import { normalizeText } from "./features.js";

export interface Intent {
  id: string;
  family: string;
  /** The bare, most common way to ask. */
  canonical: string;
  /** Same ask wrapped in filler: politeness, urgency, restatement. */
  trivial: readonly string[];
  /** Genuine rewordings that share few or no content words. */
  paraphrases: readonly string[];
  /** The authored answer a model call returns for this intent. */
  answer: string;
}

export const SYSTEM_PROMPT =
  "You are the support assistant for opsboard, a deployment and operations " +
  "platform for engineering teams. Answer account, billing, access, and " +
  "operations questions concisely and accurately. If an action is " +
  "irreversible, say so before giving the steps. Never guess at account " +
  "state you cannot see.";

export const INTENTS: readonly Intent[] = [
  {
    id: "reset-password",
    family: "credentials",
    canonical: "reset my password",
    trivial: [
      "hey can you reset my password",
      "i need to reset my password right away",
    ],
    paraphrases: [
      "i forgot what i log in with and cant get into my account",
      "locked out of the dashboard, i need new login credentials",
      "help me get back into my account, it wont accept my login anymore",
    ],
    answer:
      "Use Settings > Security > Reset password. We send a single-use link to " +
      "your account email; it expires in 15 minutes and signs out all other sessions.",
  },
  {
    id: "reset-api-key",
    family: "credentials",
    canonical: "reset my api key",
    trivial: [
      "hey can you reset my api key",
      "i need to reset my api key for the project",
    ],
    paraphrases: [
      "the token our integration authenticates with leaked, we need a fresh one",
      "rotate the secret my service uses to call you",
      "generate a new programmatic access credential, the old one is compromised",
    ],
    answer:
      "Go to Settings > API > Rotate key. The old key keeps working for 60 " +
      "minutes so deployed services can switch over, then it is revoked permanently.",
  },
  {
    id: "cancel-subscription",
    family: "billing",
    canonical: "cancel my subscription",
    trivial: [
      "hi i want to cancel my subscription",
      "how do i cancel my subscription for this account",
    ],
    paraphrases: [
      "stop billing me every month, im done with the service",
      "end the recurring charge on my card",
      "close out our paid plan for good",
    ],
    answer:
      "Billing > Plan > Cancel. Your workspace stays on the paid tier until the " +
      "period you already paid for ends, then drops to the free tier. No further charges.",
  },
  {
    id: "refund-payment",
    family: "billing",
    canonical: "refund my last payment",
    trivial: [
      "hey can you refund my last payment",
      "i want a refund on my last payment",
    ],
    paraphrases: [
      "you charged me and i want that money back",
      "the latest invoice hit my card twice, return the extra",
      "give me my money back for this month",
    ],
    answer:
      "Open Billing > Invoices, pick the charge, and choose Request refund. " +
      "Refunds within 14 days of the charge are automatic; older ones go to a human within one business day.",
  },
  {
    id: "raise-rate-limit",
    family: "limits",
    canonical: "raise my rate limit",
    trivial: [
      "hey could you raise my rate limit",
      "we need you to raise my rate limit for the api",
    ],
    paraphrases: [
      "were getting 429s under load, we need more requests per second",
      "bump how many calls per minute our app is allowed to make",
      "our traffic keeps hitting the request ceiling, lift it",
    ],
    answer:
      "Team plans can self-serve up to 100 req/s under Settings > Limits. Past " +
      "that, open a limits ticket with your peak traffic; approvals usually land within a day.",
  },
  {
    id: "raise-storage-quota",
    family: "limits",
    canonical: "raise my storage quota",
    trivial: [
      "hi please raise my storage quota",
      "we need you to raise my storage quota on the workspace",
    ],
    paraphrases: [
      "we are out of disk space on the project and need more room",
      "bump the gigabytes our workspace can hold",
      "uploads are failing because the volume is full, give us more capacity",
    ],
    answer:
      "Storage upgrades are under Settings > Limits > Storage, in 50 GB steps. " +
      "The new quota applies immediately; billing is prorated for the current period.",
  },
  {
    id: "rollback-deploy",
    family: "deploy",
    canonical: "roll back my deploy",
    trivial: [
      "hey can you roll back my deploy",
      "i need to roll back my deploy right now",
    ],
    paraphrases: [
      "the release we shipped an hour ago is broken, put the previous version live",
      "revert production to the build that worked",
      "errors spiked right after the latest ship, undo it",
    ],
    answer:
      "Deploys > select the previous green build > Promote. Rollback swaps " +
      "traffic atomically and keeps the bad build available for diagnosis. Takes about 30 seconds.",
  },
  {
    id: "rollback-migration",
    family: "deploy",
    canonical: "roll back my database migration",
    trivial: [
      "hey can you roll back my database migration",
      "we have to roll back my database migration from today",
    ],
    paraphrases: [
      "the schema change bricked the app, restore the previous table structure",
      "undo the alter we ran on the db this morning",
      "revert the sql change, half the columns are wrong now",
    ],
    answer:
      "Migration rollback is destructive if the down step drops data: check the " +
      "down script first. Database > Migrations > Revert runs it against a fresh snapshot by default.",
  },
  {
    id: "invite-teammate",
    family: "team",
    canonical: "invite a teammate to my workspace",
    trivial: [
      "hey how do i invite a teammate to my workspace",
      "i want to invite a teammate to my workspace today",
    ],
    paraphrases: [
      "add my coworker so she can see our project",
      "give a new hire access to the org",
      "get another engineer onto this account",
    ],
    answer:
      "Team > Invite, enter their email and a role. Invites expire after 7 days; " +
      "members count against your seat limit the moment they accept.",
  },
  {
    id: "remove-teammate",
    family: "team",
    canonical: "remove a teammate from my workspace",
    trivial: [
      "hey please remove a teammate from my workspace",
      "i need to remove a teammate from my workspace immediately",
    ],
    paraphrases: [
      "someone left the company, take away their access",
      "offboard a user so he cant see the org anymore",
      "revoke my former contractors seat",
    ],
    answer:
      "Team > member menu > Remove. Their sessions end within a minute and " +
      "their personal API keys are revoked. Resources they created stay with the workspace.",
  },
  {
    id: "export-data",
    family: "data",
    canonical: "export my account data",
    trivial: [
      "hi can i export my account data",
      "i would like to export my account data as a file",
    ],
    paraphrases: [
      "i need a download of everything you store about us",
      "send me a full dump of our records",
      "pull all our stuff into a file i can take elsewhere",
    ],
    answer:
      "Settings > Data > Export builds a zip of configs, logs metadata, and " +
      "billing history. You get an email link when it is ready, usually under 10 minutes.",
  },
  {
    id: "delete-data",
    family: "data",
    canonical: "delete my account data",
    trivial: [
      "hey please delete my account data",
      "i want to delete my account data completely",
    ],
    paraphrases: [
      "wipe everything you hold about me, this is a gdpr request",
      "erase all our records from your systems permanently",
      "i want every trace of us purged from your servers",
    ],
    answer:
      "Deletion is permanent and cannot be undone. Settings > Data > Delete " +
      "account starts a 7-day grace period, then all data is purged, backups included, within 30 days.",
  },
  {
    id: "create-webhook",
    family: "webhooks",
    canonical: "create a webhook for deploy events",
    trivial: [
      "hey how do i create a webhook for deploy events",
      "i want to create a webhook for deploy events on my project",
    ],
    paraphrases: [
      "i want a callback url that fires when we ship",
      "post to my endpoint every time a release happens",
      "notify my server automatically on each deployment",
    ],
    answer:
      "Settings > Webhooks > New, choose the deploy event set, and paste your " +
      "HTTPS endpoint. We sign every delivery; verify the signature header before trusting the payload.",
  },
  {
    id: "delete-webhook",
    family: "webhooks",
    canonical: "delete my webhook for deploy events",
    trivial: [
      "hey please delete my webhook for deploy events",
      "i need to delete my webhook for deploy events now",
    ],
    paraphrases: [
      "stop calling my endpoint when releases happen",
      "tear down the callback that fires on every ship",
      "my server keeps getting posts from you on each deployment, turn that off",
    ],
    answer:
      "Settings > Webhooks > endpoint menu > Delete. Deliveries stop " +
      "immediately; in-flight retries for past events are dropped too.",
  },
  {
    id: "enable-2fa",
    family: "twofactor",
    canonical: "enable two factor authentication",
    trivial: [
      "hey can you enable two factor authentication for me",
      "i want to enable two factor authentication on my account",
    ],
    paraphrases: [
      "i want a code from my phone required at login",
      "turn on the second signin step for my account",
      "make my login ask for an otp as well",
    ],
    answer:
      "Settings > Security > Two-factor > Enable, then scan the QR code with " +
      "any TOTP app. Save the recovery codes: without them a lost phone means a support ticket.",
  },
  {
    id: "disable-2fa",
    family: "twofactor",
    canonical: "disable two factor authentication",
    trivial: [
      "hey please disable two factor authentication for me",
      "i need to disable two factor authentication on my account",
    ],
    paraphrases: [
      "i lost my phone and the extra login step locks me out, turn it off",
      "stop asking me for a code every signin",
      "remove the otp requirement from my account",
    ],
    answer:
      "If you can still sign in: Settings > Security > Two-factor > Disable, " +
      "confirmed with a current code or a recovery code. If you are locked out, use account recovery; it takes 24 hours by design.",
  },
  {
    id: "download-logs",
    family: "logs",
    canonical: "download my application logs",
    trivial: [
      "hey can i download my application logs",
      "i need to download my application logs from yesterday",
    ],
    paraphrases: [
      "i need the recent stdout from our services as a file",
      "pull the last days output from the runners for me",
      "get me what the app printed overnight, were debugging",
    ],
    answer:
      "Logs > pick a service and time range > Export. Ranges up to 24h download " +
      "directly; bigger ranges build in the background and email you a link.",
  },
  {
    id: "increase-log-retention",
    family: "logs",
    canonical: "increase my application log retention",
    trivial: [
      "hey please increase my application log retention",
      "we want to increase my application log retention for the workspace",
    ],
    paraphrases: [
      "keep our output around longer than seven days",
      "we lose history too fast, store it for a month",
      "entries disappear too quickly, extend how long they stick around",
    ],
    answer:
      "Retention is per-plan: 7 days on Free, 30 on Team, 90 on Business, " +
      "configurable under Settings > Logs. Raising it applies to new logs only; expired entries are gone.",
  },
  {
    id: "report-outage",
    family: "status",
    canonical: "report an outage on the api",
    trivial: [
      "hey i want to report an outage on the api",
      "we need to report an outage on the api right now",
    ],
    paraphrases: [
      "everything is down for us, is it just our account",
      "your service stopped responding twenty minutes ago, flagging it",
      "we are seeing total failure on every call since noon",
    ],
    answer:
      "Check status.opsboard.example first; if your region shows green, open an " +
      "incident ticket with request IDs and timestamps. P1 tickets page the on-call directly.",
  },
  {
    id: "subscribe-status",
    family: "status",
    canonical: "subscribe to status updates for the api",
    trivial: [
      "hey how do i subscribe to status updates for the api",
      "i want to subscribe to status updates for the api by email",
    ],
    paraphrases: [
      "email me whenever something breaks on your side",
      "i want a ping any time the platform has an incident",
      "keep me in the loop about downtime automatically",
    ],
    answer:
      "On status.opsboard.example choose Subscribe: email, SMS, webhook, or RSS. " +
      "You can scope alerts to the components and regions you actually use.",
  },
];

/** Every phrasing of one intent, canonical first. */
export function phrasings(intent: Intent): string[] {
  return [intent.canonical, ...intent.trivial, ...intent.paraphrases];
}

export function answerFor(intentId: string): string {
  const intent = INTENTS.find((candidate) => candidate.id === intentId);
  if (intent === undefined) throw new Error(`unknown intent: ${intentId}`);
  return intent.answer;
}

/**
 * Structural checks the rest of the project relies on. Uniqueness is over
 * normalized forms: two phrasings that normalize identically would make
 * exact-match hits ambiguous, so they are banned outright.
 */
export function validateDataset(intents: readonly Intent[]): void {
  if (intents.length === 0) throw new Error("dataset is empty");
  const ids = new Set<string>();
  const seen = new Map<string, string>();
  const familySizes = new Map<string, number>();
  for (const intent of intents) {
    if (ids.has(intent.id)) throw new Error(`duplicate intent id: ${intent.id}`);
    ids.add(intent.id);
    if (intent.family.length === 0) throw new Error(`intent ${intent.id} has no family`);
    familySizes.set(intent.family, (familySizes.get(intent.family) ?? 0) + 1);
    if (intent.trivial.length < 2) throw new Error(`intent ${intent.id} needs >= 2 trivial variants`);
    if (intent.paraphrases.length < 3) throw new Error(`intent ${intent.id} needs >= 3 paraphrases`);
    if (intent.answer.trim().length === 0) throw new Error(`intent ${intent.id} has an empty answer`);
    for (const phrasing of phrasings(intent)) {
      const key = normalizeText(phrasing);
      if (key.length === 0) throw new Error(`intent ${intent.id} has an empty phrasing`);
      const owner = seen.get(key);
      if (owner !== undefined) {
        throw new Error(`phrasing collision between ${owner} and ${intent.id}: "${key}"`);
      }
      seen.set(key, intent.id);
    }
  }
  for (const [family, size] of familySizes) {
    if (size < 2) throw new Error(`family ${family} has a single intent, no near-miss pairs`);
  }
}
