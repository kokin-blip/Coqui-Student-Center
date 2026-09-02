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
      <svg
        viewBox="0 0 64 64"
        role="img"
        aria-label={wordmark ? "Coqui Student Center" : "Coqui"}
      >
        <rect className="logo-bg" x="3" y="3" width="58" height="58" rx="18" />
        <path
          className="logo-frog"
          d="M14 31c0-10.5 8.1-18 18-18s18 7.5 18 18v4c0 10.7-7.8 18-18 18s-18-7.3-18-18v-4Z"
        />
        <circle className="logo-eye" cx="21" cy="23" r="10" />
        <circle className="logo-eye" cx="43" cy="23" r="10" />
        <circle className="logo-pupil" cx="22" cy="23" r="3" />
        <circle className="logo-pupil" cx="42" cy="23" r="3" />
        <path
          className="logo-smile"
          d="M23.5 37.5c2.7 2.8 5.5 4.2 8.5 4.2s5.8-1.4 8.5-4.2"
        />
      </svg>
      {wordmark && (
        <span className="coqui-wordmark">
          <strong>coqui</strong>
          <small>Student Center</small>
        </span>
      )}
    </span>
  );
}
