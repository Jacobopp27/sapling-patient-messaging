// Safety guards. Both run in plain code, in every mode, and never depend on a model.

/** Exact text from the spec. Sent alone, never paraphrased, never followed by anything else. */
export const EMERGENCY_TEXT =
  'If you think you are having a medical emergency, call 911 or go to the nearest emergency room now. '
  + 'This text line is not monitored continuously and cannot help in an emergency.';

/**
 * Possible-emergency signals. Deliberately broad: a false positive costs one unnecessary 911
 * message; a false negative can cost much more. The Claude interpreter adds a second, semantic
 * check (possible_emergency) for phrasings these miss.
 */
const EMERGENCY_SIGNALS: [string, RegExp][] = [
  ['chest pain', /\bchest\b.{0,30}\b(pain|hurts?|tight|tightness|pressure|heavy)\b|\b(pain|pressure|tightness)\b.{0,20}\bchest\b/i],
  ['numbness / weakness', /\b(numb|numbness|tingling)\b|\bweak(ness)?\b.{0,20}\b(arm|leg|face|side)\b|\b(can'?t|cannot) (feel|move) my\b/i],
  ['stroke signs', /\b(face|mouth)\b.{0,20}\b(droop|drooping)\b|\bslurr(ed|ing)\b|\bcan'?t (speak|talk|see)\b|\bstroke\b/i],
  // With high blood pressure on file, a sudden change in vision or a severe headache is a warning sign.
  ['vision change / severe headache', /\b(blurry|blurred|double|losing|lost|loss of)\s+(vision|sight)\b|\bvision\b.{0,20}\b(blurry|blurred|double|(went|going|is going) (black|dark|out))\b|\b(worst|terrible|severe|excruciating|sudden)\b.{0,15}\bheadache\b/i],
  ['breathing', /\b(can'?t|cannot|hard to|trouble|difficulty|struggling to) breath(e|ing)?\b|\bshort(ness)? of breath\b/i],
  ['loss of consciousness', /\b(pass(ed|ing)? out|faint(ed|ing)?|unconscious|unresponsive|black(ed|ing)? out)\b/i],
  ['heart attack', /\bheart attack\b/i],
  ['severe bleeding', /\b(bleeding|blood)\b.{0,20}\b(won'?t stop|a lot|heavily|severe)\b/i],
  ['seizure', /\bseizure|convuls/i],
  ['overdose', /\b(overdose|overdosed|took too many)\b/i],
  ['self-harm', /\b(kill myself|suicid|end my life|hurt myself|self[- ]harm)\b/i],
  ['emergency', /\bemergency\b/i],
];

/**
 * The same signals in Spanish, matched on text with the accents removed ("corazón" → "corazon").
 * Found by the eval suite: "tengo dolor en el pecho y no siento el brazo izquierdo" got the
 * "pass this to staff?" reply in local mode.
 */
const EMERGENCY_SIGNALS_ES: [string, RegExp][] = [
  ['chest pain', /\bpecho\b.{0,30}\b(dolor|duele|apret\w*|presion|opresion|pesad\w*)|\b(dolor|duele|presion|opresion|apret\w*)\b.{0,20}\bpecho\b/i],
  ['numbness / weakness', /\b(entumid\w*|adormecid\w*|dormid[oa]|hormigueo)\b|\bdebil(idad)?\b.{0,20}\b(brazo|pierna|cara|lado)\b|\bno (siento|puedo mover) (el|la|los|las|mi|mis)\b/i],
  ['stroke signs', /\b(cara|boca)\b.{0,20}\b(caid[ao]|torcid[ao])\b|\barrastr\w* las palabras\b|\bno puedo (hablar|ver)\b|\b(derrame|embolia)\b/i],
  ['vision change / severe headache', /\bvision\b.{0,15}\b(borrosa|doble)\b|\bveo (borroso|doble)\b|\bperdi la vista\b|\b(peor|fuerte|terrible|intens\w*|repentin\w*)\b.{0,15}\bdolor de cabeza\b|\bdolor de cabeza\b.{0,15}\b(fuerte|terrible|intens\w*|horrible)\b/i],
  ['breathing', /\b(no puedo|me cuesta|dificultad para) respirar\b|\b(falta|me falta) (de )?(el )?aire\b|\bme ahogo\b/i],
  ['loss of consciousness', /\b(desmay\w*|inconsciente)\b|\bperdi el conocimiento\b/i],
  ['heart attack', /\b(infarto|ataque al corazon|ataque cardiaco)\b/i],
  ['severe bleeding', /\bsangr\w*\b.{0,20}\b(no (para|se detiene)|mucho|demasiad\w*)\b|\bhemorragia\b/i],
  ['seizure', /\bconvulsi\w*|\bataque epileptico\b/i],
  ['overdose', /\bsobredosis\b|\btome demasiad\w*\b/i],
  ['self-harm', /\b(matarme|suicid\w*|quitarme la vida|hacerme dano|lastimarme)\b/i],
  ['emergency', /\b(emergencia|urgencia)\b/i],
];

const withoutAccents = (text: string) => text.normalize('NFD').replace(/[\u0300-\u036f]/g, '');

export function detectEmergency(text: string): string[] {
  const plain = withoutAccents(text);
  return [...new Set([
    ...EMERGENCY_SIGNALS.filter(([, re]) => re.test(text)).map(([label]) => label),
    ...EMERGENCY_SIGNALS_ES.filter(([, re]) => re.test(plain)).map(([label]) => label),
  ])];
}

/**
 * Last check on every non-emergency reply before it is saved. Replies are template-built, so this
 * should never fire; it exists so a careless template edit (or a future model-written reply) can't
 * claim a booking, invent a deadline or give dosing advice.
 */
const FORBIDDEN_IN_REPLY: [string, RegExp][] = [
  ['claims a request is booked/approved', /\b(request|recheck|refill)\b[^.]*\b(is|has been|was|are)\s+(now\s+)?(booked|confirmed|approved|scheduled)\b/i],
  ['claims the agent took the action', /\b(I|we)\s*('ve|\s+have)?\s+(booked|scheduled|confirmed|approved|reserved|cancell?ed|rescheduled)\b/i],
  ['promises a response time', /\b(within|in the next)\s+\d+\s*(minutes?|hours?|days?|business days?)\b|\b(get back to you|hear back|respond|call you)\b[^.]*\b(today|tomorrow|soon|shortly|asap|right away)\b/i],
  ['dosing advice', /\b(take|double|skip|stop|increase|decrease|reduce|continue|keep taking)\b[^.]{0,30}\b(pills?|dose|doses|tablets?|medication|lisinopril|mg)\b/i],
];

export function checkReply(reply: string): string[] {
  return FORBIDDEN_IN_REPLY.filter(([, re]) => re.test(reply)).map(([label]) => label);
}

export const GUARD_FALLBACK_TEXT =
  "I'm not able to help with that over text. I've passed your message to the clinic staff, and it's pending staff review. "
  + "Texts are read during business hours and aren't monitored continuously.";

/**
 * On a real phone there is no "automated" label, only the text. So the first automated reply in a
 * thread says it's automated, in the message itself. (Never added to the emergency text.)
 */
export const AUTOMATED_INTRO = "This is Sapling Family Clinic's automated text assistant.";
