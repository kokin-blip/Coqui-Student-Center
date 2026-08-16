type AppLogoProps = {
  className?: string;
  wordmark?: boolean;
};

export function AppLogo({ className = "", wordmark = false }: AppLogoProps) {
  return (
    <span className={`coqui-logo ${wordmark ? "with-wordmark" : ""} ${className}`.trim()}>
      <svg
        viewBox="0 0 64 64"
        role="img"
        aria-label={wordmark ? "Coqui Student Center" : "Coqui"}
      >
        <path className="logo-bg" d="M14 3h36c6.1 0 11 4.9 11 11v36c0 6.1-4.9 11-11 11H14C7.9 61 3 56.1 3 50V14C3 7.9 7.9 3 14 3Z" />
        <path className="logo-book" d="M12 39.5c7.2-2.8 13.8-1.3 20 4.5 6.2-5.8 12.8-7.3 20-4.5v12.1c-7.3-2.1-13.9-.4-20 5.1-6.1-5.5-12.7-7.2-20-5.1V39.5Z" />
        <path className="logo-book-line" d="M32 44v12.7M15.8 43.1c5.7-1.3 10.9.3 16.2 4.9m16.2-4.9C42.5 41.8 37.3 43.4 32 48" />
        <path className="logo-frog" d="M18.2 31.3c0-9.6 6.2-16.4 13.8-16.4s13.8 6.8 13.8 16.4c0 5-2.3 9.4-6.2 12.1-2.5 1.7-5 2.6-7.6 2.6s-5.1-.9-7.6-2.6c-3.9-2.7-6.2-7.1-6.2-12.1Z" />
        <circle className="logo-eye" cx="23" cy="18" r="6" />
        <circle className="logo-eye" cx="41" cy="18" r="6" />
        <circle className="logo-pupil" cx="24" cy="18" r="2.2" />
        <circle className="logo-pupil" cx="40" cy="18" r="2.2" />
        <path className="logo-smile" d="M25 31.5c2.1 2.4 4.4 3.6 7 3.6s4.9-1.2 7-3.6" />
        <path className="logo-hand" d="M18.5 36.2c3.5-.2 6.2 1.3 8.1 4.4m18.9-4.4c-3.5-.2-6.2 1.3-8.1 4.4" />
      </svg>
      {wordmark && (
        <span className="coqui-wordmark">
          <strong>Coqui</strong>
          <small>Student Center</small>
        </span>
      )}
    </span>
  );
}
