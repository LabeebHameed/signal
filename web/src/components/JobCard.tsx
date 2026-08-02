import { useState } from "react";
import { ExternalLinkIcon } from "lucide-react";

import type { Posting } from "@/api";
import { Avatar, AvatarFallback, AvatarImage } from "@/components/ui/avatar";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardFooter, CardHeader } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { parseJobDetails } from "@/lib/parsePosting";

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
    link,
    locationText,
    compensationText,
    timeText,
  } = parseJobDetails(posting);

  const faviconUrl = websiteDomain ? `https://www.google.com/s2/favicons?domain=${websiteDomain}&sz=128` : null;

  return (
    <Card size="sm" className="h-full">
      <CardHeader className="gap-3">
        <div className="flex items-center justify-between gap-3">
          <Avatar className="size-9 rounded-lg">
            {faviconUrl && showFavicon && (
              <AvatarImage
                src={faviconUrl}
                alt={`${companyName} logo`}
                onError={() => setShowFavicon(false)}
              />
            )}
            <AvatarFallback className="rounded-lg">
              {companyName.charAt(0).toUpperCase()}
            </AvatarFallback>
          </Avatar>
          <span className="text-xs text-muted-foreground">{sourceSiteName}</span>
        </div>

        <div className="flex items-baseline justify-between gap-3">
          <span className="truncate text-sm font-medium">{companyName}</span>
          <span className="shrink-0 text-xs text-muted-foreground">{timeText}</span>
        </div>
      </CardHeader>

      <CardContent className="grid gap-3">
        {/* Only ever links to the posting's OWN url, never to the
            source-listing fallback (that would misrepresent the link as
            this specific posting). */}
        <h3 className="font-heading text-base font-medium">
          {link.isDirect && link.href ? (
            <a href={link.href} target="_blank" rel="noreferrer" className="hover:underline">
              {cleanTitle}
            </a>
          ) : (
            cleanTitle
          )}
        </h3>

        {tags.length > 0 && (
          <div className="flex flex-wrap gap-1.5">
            {tags.map((tag) => (
              <Badge key={tag} variant="secondary" className="bg-muted text-muted-foreground">
                {tag}
              </Badge>
            ))}
          </div>
        )}
      </CardContent>

      <Separator />

      <CardFooter className="mt-auto items-end justify-between gap-3">
        <div className="grid gap-0.5 text-sm">
          <span className="font-medium">{compensationText}</span>
          <span className="text-muted-foreground">{locationText}</span>
        </div>

        {link.href ? (
          <Button
            variant={link.isDirect ? "default" : "outline"}
            size="sm"
            title={link.tooltip ?? undefined}
            render={<a href={link.href} target="_blank" rel="noreferrer" />}
          >
            {link.label}
            <ExternalLinkIcon />
          </Button>
        ) : (
          <Button variant="outline" size="sm" disabled>
            {link.label}
          </Button>
        )}
      </CardFooter>
    </Card>
  );
}
