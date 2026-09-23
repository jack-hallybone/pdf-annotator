/*
 * package.json's `name`, not its `productName`: browser-storage ids (a cache
 * prefix, a write-lock name) key off this instead, so renaming the product
 * cannot orphan a reader's data.
 */
declare const __PACKAGE_NAME__: string;

export const PACKAGE_NAME: string = __PACKAGE_NAME__;
