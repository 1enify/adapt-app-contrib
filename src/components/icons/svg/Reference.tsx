import {JSX} from "solid-js";

export default function Reference(props: JSX.SvgSVGAttributes<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 196 134" {...props}>
      <path d="M12 122V69C12 37.5198 37.5198 12 69 12L184 12"
            stroke-width="24" stroke-linecap="round"/>
    </svg>
  )
}