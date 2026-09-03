import "./brand.css";

type AppLogoProps = {
  className?: string;
  wordmark?: boolean;
  monochrome?: boolean;
};

export function AppLogo({
  className = "",
  wordmark = false,
  monochrome = false,
}: AppLogoProps) {
  return (
    <span
      className={`coqui-logo ${wordmark ? "with-wordmark" : ""} ${monochrome ? "monochrome" : ""} ${className}`.trim()}
    >
      <span className={`brand-art ${wordmark ? "lockup" : "face-only"}`}>
        <img
          src="/brand/coqui-approved.png"
          alt={wordmark ? "Coqui Student Center" : "Coqui"}
        />
      </span>
      {wordmark && <small className="brand-descriptor">Student Center</small>}
    </span>
  );
}
