/* A derived class, never a list, so a code point added in a later Unicode is covered the day the regexp engine is. */

/** The class body, without the brackets, and requiring the `u` flag. */
export const HIDDEN_CHARACTER_CLASS_BODY =
  "\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}\\u2800";

/** Fresh per call: `g` regexes carry state. */
function hiddenCharacterPattern(flags = "gu") {
  return new RegExp(`[${HIDDEN_CHARACTER_CLASS_BODY}]`, flags);
}

/** Removal, not substitution: a space would paint something never in the string. `keep` is tried on one character at a time, so it must not carry the `g` flag. */
export function stripHiddenCharacters(value: string, keep?: RegExp) {
  return value.replace(hiddenCharacterPattern(), (char) =>
    keep?.test(char) ? char : "",
  );
}
