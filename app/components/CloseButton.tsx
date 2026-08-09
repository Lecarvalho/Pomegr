type CloseButtonProps = {
  label: string;
  onClick: () => void;
};

export function CloseButton({ label, onClick }: CloseButtonProps) {
  return (
    <button className="closeButton" type="button" onClick={onClick} aria-label={label}>
      <svg viewBox="0 0 12 12" aria-hidden="true" focusable="false">
        <path d="M2 2l8 8M10 2 2 10" />
      </svg>
    </button>
  );
}
