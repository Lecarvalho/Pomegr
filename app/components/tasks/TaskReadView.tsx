import { useId, type ReactNode } from "react";
import { taskImageIds } from "../../../shared/task-contract";
import { LockGlyph } from "./TaskGlyphs";
import { TaskTagChips } from "./TaskTagChips";
import { taskDocument, type TaskDocBlock, type TaskDocInline } from "./task-document";
import { BLANK_IMAGE } from "./task-rich-text";

type Images = { urls: ReadonlyMap<string, string | null>; order: readonly string[] };

function Inlines({ inlines, images }: { inlines: readonly TaskDocInline[]; images: Images }) {
  return <>{inlines.map((inline, index) => {
    if (inline.kind === "text") return inline.text;
    if (inline.kind === "code") return <code key={index} className="taskDocCode">{inline.text}</code>;
    if (inline.kind === "data") return <span key={index} className="taskDocData">{inline.text}</span>;
    const url = images.urls.get(inline.imageId) ?? null;
    // eslint-disable-next-line @next/next/no-img-element -- An object URL of this page: there is no file to optimize.
    return <img key={index} className={`taskInlineImage${url === null ? " isPending" : ""}`} src={url ?? BLANK_IMAGE} alt={`Image ${images.order.indexOf(inline.imageId) + 1}`} draggable={false} />;
  })}</>;
}

function Block({ block, images }: { block: TaskDocBlock; images: Images }) {
  const className = `taskDocBlock${block.joined ? " isJoined" : ""}`;
  if (block.kind === "paragraph") return <p className={className}><Inlines inlines={block.inlines} images={images} /></p>;
  const items = block.items.map((item, index) => <li key={index}><Inlines inlines={item} images={images} /></li>);
  return block.kind === "ordered" ? <ol className={className} start={block.start}>{items}</ol> : <ul className={className}>{items}</ul>;
}

/**
 * The Task of a started task, read-only: the tag chips, the title, and the rest as a document. The text is drawn as React text
 * only. `note` is the muted line beside the lock glyph. `error` is the modal's failure line, which stays under the Task.
 */
export function TaskReadView({ text, urls, note, error }: {
  text: string;
  urls: ReadonlyMap<string, string | null>;
  note: string;
  error?: ReactNode;
}) {
  const labelId = useId();
  const { tags, title, blocks } = taskDocument(text);
  const images: Images = { urls, order: taskImageIds(text) };
  return <section className="taskRead" aria-labelledby={labelId}>
    <div className="taskReadHead">
      <span id={labelId} className="taskReadLabel">Task</span>
      <span className="taskReadLock"><LockGlyph /><span className="taskReadNote">{note}</span></span>
    </div>
    <TaskTagChips tags={tags} />
    <h3 className="taskReadTitle"><Inlines inlines={title} images={images} /></h3>
    {blocks.length > 0 && <div className="taskDocument">{blocks.map((block, index) => <Block key={index} block={block} images={images} />)}</div>}
    {error}
  </section>;
}
