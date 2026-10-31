// The two media conditions Home's focus mode depends on, read where they are needed and not tracked: a phone, and a user who asks for less motion.

const PHONE = "(max-width: 760px)";
const REDUCED_MOTION = "(prefers-reduced-motion: reduce)";
const matches = (query: string) => typeof window !== "undefined" && typeof window.matchMedia === "function" && window.matchMedia(query).matches;

/** The width at which Home takes its phone layout (the `max-width: 760px` of the stylesheets). */
export const onPhone = () => matches(PHONE);
export const prefersLessMotion = () => matches(REDUCED_MOTION);
