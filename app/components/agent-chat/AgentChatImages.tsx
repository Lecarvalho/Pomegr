"use client";

import { useRef } from "react";
import { CommandIcon } from "../command-center/CommandIcon";
import { AGENT_CHAT_IMAGE_ACCEPT, type AgentChatImageUrls } from "./agent-chat-images";

function Picture({ url, name }: { url: string | undefined; name: string }) {
  if (!url) return <span className="agentChatImagePicture isPending" role="img" aria-label={name} />;
  // eslint-disable-next-line @next/next/no-img-element -- An object URL of this page: there is no file to optimize.
  return <img className="agentChatImagePicture" src={url} alt={name} draggable={false} />;
}

/**
 * The images of one message or one proposed operation, as small pictures in the order they were sent. An image whose
 * bytes have not arrived is an empty frame of the same size, so nothing moves when it does. `onRemove` is set only in
 * the composer, where an image is not sent yet.
 */
export function AgentChatImageStrip({ imageIds, urls, label, onRemove }: {
  imageIds: readonly string[];
  urls: AgentChatImageUrls;
  label: string;
  onRemove?(imageId: string): void;
}) {
  if (imageIds.length === 0) return null;
  return <ul className="agentChatImages" aria-label={label}>
    {imageIds.map((imageId, index) => {
      const url = urls.get(imageId);
      return <li key={imageId} className="agentChatImage">
        <Picture url={url} name={`Image ${index + 1}`} />
        {onRemove && <button type="button" className="commandIconAction agentChatImageRemove" aria-label={`Remove image ${index + 1}`} title="Remove image"
          onClick={() => onRemove(imageId)}><CommandIcon name="close" /></button>}
      </li>;
    })}
  </ul>;
}

/** The composer's Icon action that opens the file chooser. Focus stays in the message field. */
export function AgentChatImageAttach({ disabled, onAttach }: { disabled?: boolean; onAttach(files: File[]): void }) {
  const input = useRef<HTMLInputElement>(null);
  return <>
    <button type="button" className="commandIconAction agentChatAttach" aria-label="Attach image" title="Attach image" disabled={disabled}
      onMouseDown={(event) => event.preventDefault()} onClick={() => input.current?.click()}><CommandIcon name="plus" /></button>
    <input ref={input} type="file" className="agentChatImageInput" accept={AGENT_CHAT_IMAGE_ACCEPT} multiple hidden tabIndex={-1} aria-hidden="true"
      onChange={(event) => {
        const files = [...(event.currentTarget.files ?? [])];
        event.currentTarget.value = "";
        if (files.length > 0) onAttach(files);
      }} />
  </>;
}
