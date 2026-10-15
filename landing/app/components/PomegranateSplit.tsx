import styles from "./LandingPage.module.css";

// The hero's pomegranate: one dithered image of the fruit broken open, still.
export function PomegranateSplit() {
  return (
    <div className={styles.pomegranate} aria-hidden="true">
      <img src="/landing/home/pomegranate-halves.png" alt="" width="960" height="960" />
    </div>
  );
}
