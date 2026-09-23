/*
 * A derived class, never a list, so a code point added in a later Unicode is
 * covered the day the regexp engine is.
 */

/**
 * The class body, without the brackets, and requiring the `u` flag.
 */
export const HIDDEN_CHARACTER_CLASS_BODY =
  "\\p{Cc}\\p{Cf}\\p{Cs}\\p{Zl}\\p{Zp}\\p{Default_Ignorable_Code_Point}\\u2800";

/** Fresh per call: `g` regexes carry state. */
function hiddenCharacterPattern(flags = "gu") {
  return new RegExp(`[${HIDDEN_CHARACTER_CLASS_BODY}]`, flags);
}

/**
 * Removal, not substitution: a space would paint something never in the string.
 */
export function stripHiddenCharacters(value: string, keep = "") {
  return value.replace(hiddenCharacterPattern(), (char) =>
    keep.includes(char) ? char : "",
  );
}
