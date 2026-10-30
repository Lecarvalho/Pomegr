import type { ReactNode } from "react";
import { CommandIcon } from "../command-center/CommandIcon";
import styles from "./HomeArilLine.module.css";

/** The one line under the greeting, with Aril's glyph. A fixed rule writes its words (`home-model.ts`); no model does. */
export function HomeArilLine({ children, status = false }: { children: ReactNode; status?: boolean }) {
  return <span className={styles.line} role={status ? "status" : undefined}><CommandIcon name="spark" size="small" />{children}</span>;
}
