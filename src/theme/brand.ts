/**
 * Brand names in one place. Renaming the product means editing this file only.
 * The emblem (halqa-mark.png) has no lettering; the wordmark is rendered as live text by
 * <Logo>, so it always matches `ar` and `en` here.
 */
export const BRAND = {
  ar: 'الحلقة',
  en: 'HALQA',
  tagline: 'نتعلّم القرآن معًا',
} as const;

export const pageTitle = (section?: string) => `${BRAND.ar} | ${section ?? BRAND.en}`;
