import type { ContextAllocation, ContextAllocationKind } from "../../../shared/monitor-contract";
import { compactNumber } from "../../dashboard-utils";

type Category = { name: string; tokens: string; percentage: number; kind: ContextAllocationKind };

const SECTIONS: Array<{ kind: ContextAllocationKind; title: string; description: string; field: keyof ContextAllocation }> = [
  { kind: "initial", title: "Loaded initially", description: "Estimated context present before conversation content.", field: "initialTokens" },
  { kind: "deferred", title: "Deferred until needed", description: "Available definitions; not all are sent at session start.", field: "deferredTokens" },
  { kind: "reserved", title: "Reserved capacity", description: "Headroom held for automatic compaction, not prompt content.", field: "reservedTokens" },
];

export function inventoryDisplayTokens(value: { machineryTokens: number; contextAllocation: ContextAllocation | null }) {
  return value.contextAllocation?.initialTokens ?? value.machineryTokens;
}

export function ContextAllocationBreakdown({ allocation, categoryTotal, categories }: {
  allocation: ContextAllocation;
  categoryTotal: number;
  categories: Category[];
}) {
  return <section className="repositoryAllocation" aria-label="Provider-estimated context allocation">
    <div className="repositoryAllocationHead"><h3>Provider-estimated context allocation</h3><span><strong>{compactNumber(categoryTotal)}</strong> categorized total</span></div>
    <div className="repositoryAllocationBar" role="img" aria-label={`${compactNumber(allocation.initialTokens)} loaded initially, ${compactNumber(allocation.deferredTokens)} deferred until needed, and ${compactNumber(allocation.reservedTokens)} reserved for automatic compaction`}>
      {SECTIONS.map((section) => allocation[section.field] > 0 && <span className={section.kind} style={{ flexGrow: allocation[section.field] }} key={section.kind} />)}
    </div>
    <div className="repositoryAllocationLabels" aria-hidden="true">
      {SECTIONS.map((section) => <span key={section.kind}><b>{compactNumber(allocation[section.field])}</b>{section.title}</span>)}
    </div>
    <div className="repositoryAllocationSections">
      {SECTIONS.map((section) => <section className={`repositoryAllocationSection ${section.kind}`} key={section.kind}>
        <header><h3>{section.title}</h3><strong>{compactNumber(allocation[section.field])}</strong><p>{section.description}</p></header>
        {categories.filter((category) => category.kind === section.kind).map((category) => <div className="repositoryAllocationCategory" key={category.name}><span>{category.name}</span><b>{category.tokens}</b><small>{category.percentage}%</small></div>)}
      </section>)}
    </div>
  </section>;
}
