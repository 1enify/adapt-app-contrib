import {JSX} from "solid-js";

export default function Bell(props: JSX.SvgSVGAttributes<SVGSVGElement>) {
  return (
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 448 512" {...props}>
      {/*Font Awesome Free 6.5.2 by @fontawesome - https://fontawesome.com License - https://fontawesome.com/license/free Copyright 2024 Fonticons, Inc.*/}
      <path d="M224 0c-17.7 0-32 14.3-32 32V51.2C119 66.4 64 130.6 64 208v18.8c0 47-17.3 92.4-48.5 127.6l-7.4 8.3c-8.4 9.4-10.4 22.9-5.3 34.4S19.4 416 32 416H416c12.6 0 24-7.4 29.2-18.9s3.1-25-5.3-34.4l-7.4-8.3C401.3 319.2 384 273.9 384 226.8V208c0-77.4-55-142.1-128-156.8V32c0-17.7-14.3-32-32-32zM160 448c0 17.7 14.3 32 32 32s32-14.3 32-32H160z"/>
    </svg>
  )
} 