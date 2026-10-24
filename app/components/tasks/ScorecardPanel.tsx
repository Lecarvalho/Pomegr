"use client";

import { useEffect, useId, useRef, useState, type RefObject } from "react";
import { CommandIcon } from "../command-center/CommandIcon";
import { scorecardRows, type Scorecard, type ScorecardAnswer } from "./scorecard-model";
import { TaskDialog } from "./TaskModalFrame";

export type ScorecardRead = { state: "pending" } | { state: "failed" } | { state: "ready"; scorecard: Scorecard };

const day = (at: number) => new Date(at).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });

function Measures({ card }: { card: Scorecard }) {
  const { current, baseline } = card;
  return <>
    <div className="taskScorecardColumns" aria-hidden="true">
      <span />
      <span>Now · {current.version}</span>
      <span>Baseline · {baseline ? baseline.version : "none yet"}</span>
    </div>
    <dl className="taskGateList taskScorecardList">
      {scorecardRows(card).map((row) => <div key={row.label} className="taskGateRow taskScorecardRow">
        <dt>
          <span className="taskScorecardMeasure"><span className="taskScorecardId">{row.id}</span> {row.label}</span>
          <span className="taskGatesCaption">{row.pending ? `${row.caption} ${row.pending}` : row.caption}</span>
        </dt>
        <dd className="taskScorecardValues" aria-label={`Now, ${current.version}`}>
          {row.pending ? <span className="taskScorecardNoData">—</span> : row.now === null
            ? <span className="taskScorecardNoData">No data</span>
            : <><span className="taskGateValue isMono">{row.now}</span><span className="taskScorecardSample">n {row.sample}</span></>}
        </dd>
        <dd className="taskScorecardValues" aria-label={baseline ? `Baseline, ${baseline.version}` : "Baseline"}>
          {row.baseline === null ? <span className="taskScorecardNoData">—</span> : <span className="taskGateValue isMono">{row.baseline}</span>}
        </dd>
      </div>)}
    </dl>
    <p className="taskGatesCaption">
      {baseline
        ? `The baseline is the first snapshot, saved ${day(baseline.takenAt)} in ${baseline.version}.`
        : "This version's values become the baseline that later versions compare against."}
      {" "}Scorecard values stay on this computer.
    </p>
  </>;
}

/** The panel's content: every measure, now and at the baseline, with its sample. Values stay on this computer. */
export function ScorecardPanel({ read, onClose, titleId, closeRef }: { read: ScorecardRead; onClose(): void; titleId: string; closeRef?: RefObject<HTMLButtonElement | null> }) {
  return <div className="taskQueueSettings taskScorecard" aria-busy={read.state === "pending" || undefined}>
    <header className="taskQueueSettingsHead">
      <h2 id={titleId}>Scorecard</h2>
      <button ref={closeRef} type="button" className="commandIconAction" aria-label="Close" onClick={onClose}><CommandIcon name="close" /></button>
    </header>
    <p className="taskGatesCaption">Heuristic proxies from this board&apos;s Done tasks. Owner time is never measured directly. A dash means not measured yet.</p>
    {read.state === "pending" && <p className="taskGatesCaption">Reading the scorecard…</p>}
    {read.state === "failed" && <p className="taskGatesCaption" role="alert">The scorecard could not be read. Close the panel and open it again to retry.</p>}
    {read.state === "ready" && <Measures card={read.scorecard} />}
  </div>;
}

/** The scorecard as a side panel at the right edge of the Tasks page, like Queue settings. It reads once, when it opens. */
export function ScorecardDialog({ readScorecard, returnFocus, onClose }: { readScorecard(): Promise<ScorecardAnswer>; returnFocus: RefObject<HTMLElement | null>; onClose(): void }) {
  const titleId = useId();
  const closeRef = useRef<HTMLButtonElement>(null);
  const [read, setRead] = useState<ScorecardRead>({ state: "pending" });
  useEffect(() => {
    closeRef.current?.focus({ preventScroll: true });
    const opener = returnFocus.current;
    return () => { if (opener?.isConnected) opener.focus({ preventScroll: true }); };
  }, [returnFocus]);
  useEffect(() => {
    let current = true;
    void readScorecard().then((answer) => { if (current) setRead(answer.ok ? { state: "ready", scorecard: answer.scorecard } : { state: "failed" }); });
    return () => { current = false; };
  }, [readScorecard]);
  return <TaskDialog className="taskModalScrim taskQueueSettingsScrim" labelledBy={titleId} closeOnScrim onClose={onClose}>
    <ScorecardPanel read={read} onClose={onClose} titleId={titleId} closeRef={closeRef} />
  </TaskDialog>;
}
