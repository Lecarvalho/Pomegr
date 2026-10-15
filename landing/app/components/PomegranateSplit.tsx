import styles from "./LandingPage.module.css";

const SRC = "/landing/home/pomegranate-halves.png";

// The hero's pomegranate: one dithered image cut along the gap into two halves that start
// closed and crack apart.
export function PomegranateSplit() {
  return (
    <div className={styles.pomegranate} aria-hidden="true">
      <img className={styles.halfLeft} src={SRC} alt="" width="960" height="960" />
      <img className={styles.halfRight} src={SRC} alt="" width="960" height="960" />
    </div>
  );
}
