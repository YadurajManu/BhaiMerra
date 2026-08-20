// Easing curves are chosen per-behaviour, not applied uniformly.
// expo  -> content arriving (decelerates hard, feels like it settles)
// snap  -> small UI acknowledgements (slight overshoot)
// glide -> long scroll-linked movement (no character, must not distract)
export const EASE = {
  expo: [0.16, 1, 0.3, 1],
  snap: [0.34, 1.4, 0.64, 1],
  glide: [0.4, 0.0, 0.2, 1],
  drop: [0.6, 0.02, 0.35, 1],
}

export const SPRING = {
  magnet: { type: 'spring', stiffness: 220, damping: 18, mass: 0.6 },
  press: { type: 'spring', stiffness: 480, damping: 26, mass: 0.5 },
}

export function revealVariants({ y = 18, blur = false, duration = 0.72 } = {}) {
  return {
    hidden: { opacity: 0, y, filter: blur ? 'blur(6px)' : 'none' },
    show: (i = 0) => ({
      opacity: 1,
      y: 0,
      filter: 'none',
      transition: {
        duration,
        delay: i * 0.075, // 75ms stagger across siblings
        ease: EASE.expo,
      },
    }),
  }
}

export const reducedVariants = {
  hidden: { opacity: 0 },
  show: { opacity: 1, transition: { duration: 0.3 } },
}
