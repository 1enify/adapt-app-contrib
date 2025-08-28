import { JSX } from "solid-js";

export default function Funnel(props: JSX.SvgSVGAttributes<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 24 24" fill="currentColor" width="1em" height="1em" {...props}>
      <path d="M3 4h18l-7 7v6l-4 2v-8L3 4z" />
    </svg>
  );
}

