/*
 * PDF has no flag for "come back to this", so the star is a private key in the
 * annotation dictionary: unknown keys are legal and other readers ignore them.
 */
export const ANNOTATION_BOOKMARK_KEY = "PANN_Starred";
