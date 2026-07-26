import { useState } from "react";
import type { Posting } from "../api";
import { parseJobDetails } from "../lib/parsePosting";

interface JobCardProps {
  posting: Posting;
}

export function JobCard({ posting }: JobCardProps) {
  const [showFavicon, setShowFavicon] = useState(true);

  const {
    cleanTitle,
    tags,
    companyName,
    sourceSiteName,
    websiteDomain,
    postingUrl,
    locationText,
    compensationText,
    timeText,
  } = parseJobDetails(posting);

  const faviconUrl = websiteDomain ? `https://www.google.com/s2/favicons?domain=${websiteDomain}&sz=128` : null;

  return (
    <article className="job-card">
      {/* Top Header Row: Logo Avatar + Source Site Name */}
      <div className="job-card-header">
        <div className="job-card-avatar">
          {faviconUrl && showFavicon ? (
            <img
              src={faviconUrl}
              alt={`${companyName} logo`}
              onError={() => setShowFavicon(false)}
            />
          ) : (
            <span className="job-card-avatar-fallback">
              {companyName.charAt(0).toUpperCase()}
            </span>
          )}
        </div>
        <span className="job-card-source">{sourceSiteName}</span>
      </div>

      {/* Company Name & Time */}
      <div className="job-card-meta">
        <span className="job-card-company-name">{companyName}</span>
        <span className="job-card-time">{timeText}</span>
      </div>

      {/* Clean Job Title */}
      <h3 className="job-card-title">
        {postingUrl ? (
          <a href={postingUrl} target="_blank" rel="noreferrer">
            {cleanTitle}
          </a>
        ) : (
          cleanTitle
        )}
      </h3>

      {/* Pill Tags */}
      {tags.length > 0 && (
        <div className="job-card-tags">
          {tags.map((tag) => (
            <span key={tag} className="job-card-tag">
              {tag}
            </span>
          ))}
        </div>
      )}

      {/* Horizontal Divider Line */}
      <hr className="job-card-divider" />

      {/* Footer: Compensation & Location (Left), View Posting Button (Right) */}
      <div className="job-card-footer">
        <div className="job-card-footer-left">
          <div className="job-card-comp">{compensationText}</div>
          <div className="job-card-loc">{locationText}</div>
        </div>

        <div className="job-card-footer-right">
          {postingUrl ? (
            <a
              href={postingUrl}
              target="_blank"
              rel="noreferrer"
              className="job-card-view-btn"
            >
              View Posting
              <svg
                width="13"
                height="13"
                viewBox="0 0 24 24"
                fill="none"
                stroke="currentColor"
                strokeWidth="2"
                strokeLinecap="round"
                strokeLinejoin="round"
                style={{ marginLeft: "5px", verticalAlign: "middle" }}
              >
                <path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" />
                <polyline points="15 3 21 3 21 9" />
                <line x1="10" y1="14" x2="21" y2="3" />
              </svg>
            </a>
          ) : (
            <span className="job-card-view-btn disabled">View Posting</span>
          )}
        </div>
      </div>
    </article>
  );
}
