"use client";

type TechLinesProps = {
  variant?: "sidebar" | "top";
  className?: string;
};

export function TechLines({
  variant = "top",
  className = "",
}: TechLinesProps) {
  const isSidebar = variant === "sidebar";

  return (
    <div
      aria-hidden="true"
      className={[
        "pointer-events-none absolute overflow-hidden z-0",
        isSidebar
          ? "bottom-0 left-0 h-[42%] w-full opacity-55"
          : "right-0 top-0 h-[220px] w-[58%] opacity-50",
        className,
      ].join(" ")}
      style={{
        maskImage: isSidebar
          ? "linear-gradient(to top, rgba(0,0,0,1), rgba(0,0,0,0))"
          : "linear-gradient(to left, rgba(0,0,0,1), rgba(0,0,0,0))",
        WebkitMaskImage: isSidebar
          ? "linear-gradient(to top, rgba(0,0,0,1), rgba(0,0,0,0))"
          : "linear-gradient(to left, rgba(0,0,0,1), rgba(0,0,0,0))",
      }}
    >
      <svg
        viewBox="0 0 720 320"
        className="h-full w-full"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
      >
        <g stroke="rgba(58,110,92,0.28)" strokeWidth="1">
          <path d="M0 64H720" />
          <path d="M0 128H640" />
          <path d="M80 192H720" />
          <path d="M40 256H540" />

          <path d="M120 0V320" />
          <path d="M240 40V320" />
          <path d="M360 0V260" />
          <path d="M520 80V320" />
          <path d="M620 0V220" />

          <path d="M120 64C120 64 120 104 160 104H240" />
          <path d="M240 128C240 128 240 168 280 168H420" />
          <path d="M360 64C360 64 360 104 400 104H520" />
          <path d="M520 192C520 192 520 232 560 232H720" />

          <circle cx="120" cy="64" r="4" fill="rgba(58,110,92,0.24)" stroke="none" />
          <circle cx="240" cy="128" r="4" fill="rgba(58,110,92,0.24)" stroke="none" />
          <circle cx="360" cy="64" r="4" fill="rgba(58,110,92,0.24)" stroke="none" />
          <circle cx="520" cy="192" r="4" fill="rgba(58,110,92,0.24)" stroke="none" />
          <circle cx="620" cy="128" r="4" fill="rgba(58,110,92,0.24)" stroke="none" />
        </g>
      </svg>
    </div>
  );
}