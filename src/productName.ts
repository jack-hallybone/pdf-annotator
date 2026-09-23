/*
 * Display only: the directory-picker id and the write-lock name come from the
 * package identifier instead, so a rename cannot orphan a reader's data.
 */
declare const __PRODUCT_NAME__: string;

export const PRODUCT_NAME: string = __PRODUCT_NAME__;
