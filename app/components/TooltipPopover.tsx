import { forwardRef, type CSSProperties, type ReactNode } from "react";

type TooltipPopoverProps = {
  children: ReactNode;
  className?: string;
  id?: string;
  placement?: "top" | "bottom";
  style?: CSSProperties;
};

export const TooltipPopover = forwardRef<HTMLSpanElement, TooltipPopoverProps>(function TooltipPopover({
  children,
  className = "",
  id,
  placement,
  style,
}, ref) {
  return (
    <span
      ref={ref}
      id={id}
      className={`tooltipPopover ${className}`.trim()}
      data-placement={placement}
      role="tooltip"
      style={style}
    >
      {children}
    </span>
  );
});
