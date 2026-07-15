package jobs

import (
	"bytes"
	"context"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"errors"
	"feedmind/server/internal/fetchsafe"
	"feedmind/server/internal/htmlfetch"
	"fmt"
	"github.com/PuerkitoBio/goquery"
	"github.com/go-shiori/go-readability"
	"github.com/jackc/pgx/v5/pgxpool"
	"github.com/microcosm-cc/bluemonday"
	"github.com/mmcdole/gofeed"
	"golang.org/x/net/html"
	"log/slog"
	"net/http"
	"net/url"
	"regexp"
	"strings"
	"time"
)

type Runner struct {
	DB        *pgxpool.Pool
	Fetch     *fetchsafe.Client
	HTMLFetch *htmlfetch.Client
}
type job struct {
	ID, Type string
	Payload  []byte
	Attempts int
}

type jobRunError struct {
	job   job
	cause error
}

func (e *jobRunError) Error() string { return e.cause.Error() }
func (e *jobRunError) Unwrap() error { return e.cause }

func (r *Runner) Scheduler(ctx context.Context) {
	t := time.NewTicker(time.Minute)
	defer t.Stop()
	for {
		r.enqueueDue(ctx)
		select {
		case <-ctx.Done():
			return
		case <-t.C:
		}
	}
}
func (r *Runner) enqueueDue(ctx context.Context) {
	tag, e := r.DB.Exec(ctx, `INSERT INTO jobs(type,idempotency_key,payload) SELECT 'fetch_feed',id::text,jsonb_build_object('feedId',id) FROM feeds WHERE next_fetch_at<=now() AND EXISTS(SELECT 1 FROM user_feed_subscriptions WHERE feed_id=feeds.id AND enabled) ON CONFLICT DO NOTHING`)
	if e != nil {
		slog.ErrorContext(ctx, "schedule feeds failed", "error", e)
		return
	}
	if count := tag.RowsAffected(); count > 0 {
		slog.DebugContext(ctx, "feed jobs scheduled", "count", count)
	}
}
func (r *Runner) Worker(ctx context.Context, workerID int) {
	for {
		claimed, e := r.runOne(ctx)
		if e != nil && !errors.Is(e, context.Canceled) {
			var jobErr *jobRunError
			if errors.As(e, &jobErr) {
				attrs := []any{
					"worker", workerID,
					"job_id", jobErr.job.ID,
					"job_type", jobErr.job.Type,
					"attempt", jobErr.job.Attempts,
					"error", jobErr.cause,
				}
				attrs = append(attrs, jobEntityAttrs(jobErr.job)...)
				slog.ErrorContext(ctx, "background job failed", attrs...)
			} else {
				slog.ErrorContext(ctx, "background worker failed", "worker", workerID, "error", e)
			}
		}
		if claimed && e == nil {
			continue
		}
		select {
		case <-ctx.Done():
			return
		case <-time.After(time.Second):
		}
	}
}
func (r *Runner) runOne(ctx context.Context) (bool, error) {
	tx, e := r.DB.Begin(ctx)
	if e != nil {
		return false, e
	}
	defer tx.Rollback(ctx)
	j := job{}
	e = tx.QueryRow(ctx, `UPDATE jobs SET status='running',attempts=attempts+1,lease_until=now()+interval '2 minutes',updated_at=now() WHERE id=(SELECT id FROM jobs WHERE (status='queued' AND run_at<=now()) OR (status='running' AND lease_until<now()) ORDER BY priority DESC,run_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING id,type,payload,attempts`).Scan(&j.ID, &j.Type, &j.Payload, &j.Attempts)
	if e != nil {
		_ = tx.Commit(ctx)
		return false, nil
	}
	if e = tx.Commit(ctx); e != nil {
		return false, e
	}
	jobCtx := htmlfetch.WithRequestID(ctx, jobRequestID(j))
	switch j.Type {
	case "fetch_feed":
		e = r.fetchFeed(jobCtx, j.Payload)
	case "parse_article":
		e = r.parseArticle(jobCtx, j.Payload)
	default:
		e = fmt.Errorf("unknown job type %q", j.Type)
	}
	if e == nil {
		_, e = r.DB.Exec(ctx, "UPDATE jobs SET status='done',lease_until=NULL,updated_at=now() WHERE id=$1", j.ID)
		return true, e
	}
	delay := time.Duration(1<<min(j.Attempts, 8)) * time.Minute
	maxAttempts := maxJobAttempts(e)
	_, persistErr := r.DB.Exec(ctx, "UPDATE jobs SET status=CASE WHEN attempts>=$4 THEN 'failed' ELSE 'queued' END,run_at=now()+$2::interval,lease_until=NULL,last_error=$3,updated_at=now() WHERE id=$1", j.ID, fmt.Sprintf("%d seconds", int(delay.Seconds())), safeError(e), maxAttempts)
	if persistErr != nil {
		e = errors.Join(e, fmt.Errorf("persist job failure: %w", persistErr))
	}
	return true, &jobRunError{job: j, cause: e}
}

func jobEntityAttrs(j job) []any {
	switch j.Type {
	case "fetch_feed":
		var payload feedPayload
		if json.Unmarshal(j.Payload, &payload) == nil && payload.FeedID != "" {
			return []any{"feed_id", payload.FeedID}
		}
	case "parse_article":
		var payload articlePayload
		if json.Unmarshal(j.Payload, &payload) == nil && payload.ArticleID != "" {
			return []any{"article_id", payload.ArticleID}
		}
	}
	return nil
}

func jobRequestID(j job) string {
	var payload struct {
		RequestID string `json:"requestId"`
	}
	if json.Unmarshal(j.Payload, &payload) != nil {
		return ""
	}
	return payload.RequestID
}
func min(a, b int) int {
	if a < b {
		return a
	}
	return b
}
func safeError(e error) string {
	x := e.Error()
	if len(x) > 500 {
		x = x[:500]
	}
	return x
}

func maxJobAttempts(err error) int {
	if htmlfetch.IsWorkerFallbackFailure(err) {
		return 3
	}
	return 8
}

type feedPayload struct {
	FeedID    string `json:"feedId"`
	RequestID string `json:"requestId,omitempty"`
}
type articlePayload struct {
	ArticleID string `json:"articleId"`
	RequestID string `json:"requestId,omitempty"`
}

func (r *Runner) fetchFeed(ctx context.Context, raw []byte) error {
	var p feedPayload
	if json.Unmarshal(raw, &p) != nil || p.FeedID == "" {
		return errors.New("invalid feed payload")
	}
	var feedURL, etag, lastModified string
	e := r.DB.QueryRow(ctx, `SELECT url,COALESCE(etag,''),COALESCE(last_modified,'') FROM feeds WHERE id=$1`, p.FeedID).Scan(&feedURL, &etag, &lastModified)
	if e != nil {
		return e
	}
	var locked bool
	if e = r.DB.QueryRow(ctx, "SELECT pg_try_advisory_lock(hashtext($1))", p.FeedID).Scan(&locked); e != nil || !locked {
		return e
	}
	defer func() {
		if _, unlockErr := r.DB.Exec(context.Background(), "SELECT pg_advisory_unlock(hashtext($1))", p.FeedID); unlockErr != nil {
			slog.WarnContext(ctx, "feed advisory unlock failed", "feed_id", p.FeedID, "error", unlockErr)
		}
	}()
	if _, e = r.DB.Exec(ctx, "UPDATE feeds SET fetch_status='fetching',last_attempt_at=now() WHERE id=$1", p.FeedID); e != nil {
		return e
	}
	result, e := r.HTMLFetch.GetFeed(ctx, feedURL, map[string]string{"If-None-Match": etag, "If-Modified-Since": lastModified})
	if e != nil {
		if persistErr := r.failFeed(ctx, p.FeedID, e); persistErr != nil {
			e = errors.Join(e, fmt.Errorf("persist feed failure: %w", persistErr))
		}
		return e
	}
	if result.StatusCode == http.StatusNotModified {
		_, e = r.DB.Exec(ctx, "UPDATE feeds SET fetch_status='ok',last_success_at=now(),failure_count=0,last_error=NULL,next_fetch_at=now()+interval '15 minutes',updated_at=now() WHERE id=$1", p.FeedID)
		return e
	}
	if result.StatusCode < 200 || result.StatusCode >= 300 {
		e = fmt.Errorf("feed returned HTTP %d", result.StatusCode)
		if persistErr := r.failFeed(ctx, p.FeedID, e); persistErr != nil {
			e = errors.Join(e, fmt.Errorf("persist feed failure: %w", persistErr))
		}
		return e
	}
	parsed, e := gofeed.NewParser().Parse(strings.NewReader(string(result.Body)))
	if e != nil {
		if persistErr := r.failFeed(ctx, p.FeedID, e); persistErr != nil {
			e = errors.Join(e, fmt.Errorf("persist feed failure: %w", persistErr))
		}
		return e
	}
	feedTitle := r.resolveFeedTitle(ctx, feedURL, parsed)
	tx, e := r.DB.Begin(ctx)
	if e != nil {
		return e
	}
	defer tx.Rollback(ctx)
	_, e = tx.Exec(ctx, `UPDATE feeds SET title=COALESCE(NULLIF($2,''),title),site_url=NULLIF($3,''),description=NULLIF($4,''),etag=NULLIF($5,''),last_modified=NULLIF($6,''),fetch_status='ok',last_success_at=now(),failure_count=0,last_error=NULL,next_fetch_at=now()+interval '15 minutes',updated_at=now() WHERE id=$1`, p.FeedID, feedTitle, parsed.Link, parsed.Description, result.ETag, result.LastModified)
	if e != nil {
		return e
	}
	for _, item := range parsed.Items {
		id := articleIdentity(item)
		published := item.PublishedParsed
		if published == nil {
			published = item.UpdatedParsed
		}
		var articleID string
		e = tx.QueryRow(ctx, `INSERT INTO articles(feed_id,guid,source_url,identity_hash,title,author,published_at) VALUES($1,NULLIF($2,''),NULLIF($3,''),$4,$5,NULLIF($6,''),$7) ON CONFLICT(feed_id,identity_hash) DO UPDATE SET title=EXCLUDED.title,author=EXCLUDED.author,published_at=EXCLUDED.published_at,updated_at=now() RETURNING id`, p.FeedID, item.GUID, item.Link, id, defaultString(item.Title, "Untitled"), itemAuthor(item), published).Scan(&articleID)
		if e != nil {
			return e
		}
		_, e = tx.Exec(ctx, `INSERT INTO jobs(type,idempotency_key,payload) VALUES('parse_article',$1,jsonb_build_object('articleId',$1::text,'requestId',$2::text)) ON CONFLICT DO NOTHING`, articleID, p.RequestID)
		if e != nil {
			return e
		}
	}
	return tx.Commit(ctx)
}
func (r *Runner) resolveFeedTitle(ctx context.Context, feedURL string, parsed *gofeed.Feed) string {
	if title := strings.TrimSpace(parsed.Title); title != "" {
		return title
	}
	siteURL := strings.TrimSpace(parsed.Link)
	if siteURL != "" {
		result, err := r.HTMLFetch.Get(ctx, siteURL)
		if err == nil && result.StatusCode >= 200 && result.StatusCode < 300 {
			if doc, parseErr := goquery.NewDocumentFromReader(bytes.NewReader(result.Body)); parseErr == nil {
				if title := strings.TrimSpace(doc.Find("title").First().Text()); title != "" {
					return title
				}
			}
		}
	}
	if u, err := url.Parse(siteURL); err == nil && u.Hostname() != "" {
		return strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	}
	if u, err := url.Parse(feedURL); err == nil {
		return strings.TrimPrefix(strings.ToLower(u.Hostname()), "www.")
	}
	return ""
}
func (r *Runner) failFeed(ctx context.Context, id string, cause error) error {
	_, err := r.DB.Exec(ctx, `UPDATE feeds SET fetch_status='error',last_failure_at=now(),failure_count=failure_count+1,last_error=$2,next_fetch_at=now()+make_interval(secs=>LEAST(86400,300*power(2,LEAST(failure_count,8))::int)),updated_at=now() WHERE id=$1`, id, safeError(cause))
	return err
}
func articleIdentity(x *gofeed.Item) string {
	value := strings.TrimSpace(x.GUID)
	if value == "" {
		value = strings.TrimSpace(x.Link)
	}
	if value == "" {
		value = x.Title + "|" + x.Published + "|" + x.Description
	}
	sum := sha256.Sum256([]byte(value))
	return hex.EncodeToString(sum[:])
}
func itemAuthor(x *gofeed.Item) string {
	if x.Author != nil {
		return x.Author.Name
	}
	return ""
}
func defaultString(x, d string) string {
	if strings.TrimSpace(x) == "" {
		return d
	}
	return x
}
func extractReadableArticle(body []byte, pageURL *url.URL) (readability.Article, error) {
	parser := readability.NewParser()
	parser.KeepClasses = true
	return parser.Parse(strings.NewReader(string(protectArticleFormulas(body))), pageURL)
}

// protectArticleFormulas converts formula sources before Readability removes
// script elements and other non-prose markup. The resulting custom element is
// inert and is filtered again by sanitize before it reaches a client.
func protectArticleFormulas(body []byte) []byte {
	document, err := html.Parse(strings.NewReader(string(body)))
	if err != nil {
		return body
	}
	normalizeCenteredImageWrappers(document)
	normalizeArticleFormulas(document)
	var output strings.Builder
	if err := html.Render(&output, document); err != nil {
		return body
	}
	return []byte(output.String())
}

// normalizeCenteredImageWrappers keeps editorial images that Readability can
// otherwise discard with their short, link-heavy attribution. A common Hugo
// pattern wraps such an image in center > div; figure preserves the semantics
// without matching Readability's conditional div cleanup.
func normalizeCenteredImageWrappers(root *html.Node) {
	var visit func(*html.Node)
	visit = func(node *html.Node) {
		if node.Type == html.ElementNode && strings.EqualFold(node.Data, "div") &&
			node.Parent != nil && node.Parent.Type == html.ElementNode && strings.EqualFold(node.Parent.Data, "center") &&
			countDescendantElements(node, "img") == 1 && !hasDescendantElements(node, "video", "audio", "iframe", "object", "embed") {
			node.Data = "figure"
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
	}
	visit(root)
}

func countDescendantElements(root *html.Node, tag string) int {
	count := 0
	var visit func(*html.Node)
	visit = func(node *html.Node) {
		if node.Type == html.ElementNode && strings.EqualFold(node.Data, tag) {
			count++
		}
		for child := node.FirstChild; child != nil; child = child.NextSibling {
			visit(child)
		}
	}
	for child := root.FirstChild; child != nil; child = child.NextSibling {
		visit(child)
	}
	return count
}

func hasDescendantElements(root *html.Node, tags ...string) bool {
	for _, tag := range tags {
		if countDescendantElements(root, tag) > 0 {
			return true
		}
	}
	return false
}
func (r *Runner) parseArticle(ctx context.Context, raw []byte) error {
	var p articlePayload
	if json.Unmarshal(raw, &p) != nil || p.ArticleID == "" {
		return errors.New("invalid article payload")
	}
	var sourceURL string
	e := r.DB.QueryRow(ctx, "SELECT COALESCE(source_url,'') FROM articles WHERE id=$1", p.ArticleID).Scan(&sourceURL)
	if e != nil {
		return e
	}
	if _, e = r.DB.Exec(ctx, "UPDATE articles SET parse_status='parsing',parse_error=NULL,updated_at=now() WHERE id=$1", p.ArticleID); e != nil {
		return e
	}
	fullHTML := ""
	articleTitle := ""
	articleBaseURL := sourceURL
	var extractionErr error
	if sourceURL == "" {
		extractionErr = errors.New("article source URL is empty")
	} else {
		result, fetchErr := r.HTMLFetch.Get(ctx, sourceURL)
		switch {
		case fetchErr != nil:
			extractionErr = fmt.Errorf("fetch article page: %w", fetchErr)
		case result.StatusCode < 200 || result.StatusCode >= 300:
			extractionErr = fmt.Errorf("article page returned HTTP %d", result.StatusCode)
		default:
			if result.FinalURL != nil {
				articleBaseURL = result.FinalURL.String()
			}
			article, parseErr := extractReadableArticle(result.Body, result.FinalURL)
			if parseErr != nil {
				extractionErr = fmt.Errorf("extract article page: %w", parseErr)
			} else if strings.TrimSpace(article.Content) == "" {
				extractionErr = errors.New("extract article page: empty content")
			} else {
				fullHTML = normalizeArticleTextMarkers(article.Content)
				articleTitle = strings.TrimSpace(article.Title)
			}
		}
	}
	clean := sanitize(fullHTML, articleBaseURL)
	text := bluemonday.StrictPolicy().Sanitize(clean)
	thumbnailURL := extractThumbnailURL(clean, articleBaseURL)
	sum := sha256.Sum256([]byte(clean))
	parseStatus := "ok"
	parseError := ""
	if extractionErr != nil {
		parseStatus = "error"
		parseError = safeError(extractionErr)
	}
	_, e = r.DB.Exec(ctx, `UPDATE articles SET title=CASE WHEN title=source_url AND NULLIF($8,'') IS NOT NULL THEN $8 ELSE title END,content_html=$2,content_text=$3,thumbnail_url=NULLIF($4,''),content_hash=$5,parse_status=$6,parser_version=10,parse_error=NULLIF($7,''),parsed_at=now(),updated_at=now() WHERE id=$1`, p.ArticleID, clean, strings.TrimSpace(text), thumbnailURL, hex.EncodeToString(sum[:]), parseStatus, parseError, articleTitle)
	if e != nil {
		return e
	}
	if parseStatus == "error" {
		return extractionErr
	}
	return nil
}

var articleTextMarkerPattern = regexp.MustCompile(`(?:img|https?)://[^\s<>]+`)

func normalizeArticleTextMarkers(input string) string {
	document, err := goquery.NewDocumentFromReader(strings.NewReader(input))
	if err != nil {
		return input
	}
	body := document.Find("body").First()
	if body.Length() == 0 {
		return input
	}
	normalizeProsePreBlocks(body)
	var visit func(*html.Node, bool)
	visit = func(node *html.Node, blocked bool) {
		if node.Type == html.ElementNode {
			switch strings.ToLower(node.Data) {
			case "a", "code", "pre", "script", "style":
				blocked = true
			}
		}
		if node.Type == html.TextNode && !blocked {
			replaceArticleTextMarkers(node)
			return
		}
		for child := node.FirstChild; child != nil; {
			next := child.NextSibling
			visit(child, blocked)
			child = next
		}
	}
	visit(body.Get(0), false)
	normalized, err := body.Html()
	if err != nil {
		return input
	}
	return normalized
}

func normalizeProsePreBlocks(body *goquery.Selection) {
	body.Find("pre").Each(func(_ int, pre *goquery.Selection) {
		text := strings.ReplaceAll(pre.Text(), "\r\n", "\n")
		if pre.Find("code").Length() > 0 || pre.Find("a,img").Length() == 0 || !strings.Contains(text, "\n\n") {
			return
		}
		node := pre.Get(0)
		node.Data = "div"
		expandTextNewlines(node)
	})
}

func expandTextNewlines(node *html.Node) {
	for child := node.FirstChild; child != nil; {
		next := child.NextSibling
		if child.Type == html.TextNode && strings.ContainsAny(child.Data, "\r\n") {
			value := strings.ReplaceAll(child.Data, "\r\n", "\n")
			parts := strings.Split(value, "\n")
			for index, part := range parts {
				if part != "" {
					node.InsertBefore(&html.Node{Type: html.TextNode, Data: part}, child)
				}
				if index < len(parts)-1 {
					node.InsertBefore(&html.Node{Type: html.ElementNode, Data: "br"}, child)
				}
			}
			node.RemoveChild(child)
		} else {
			expandTextNewlines(child)
		}
		child = next
	}
}

func replaceArticleTextMarkers(node *html.Node) {
	matches := articleTextMarkerPattern.FindAllStringIndex(node.Data, -1)
	if len(matches) == 0 || node.Parent == nil {
		return
	}
	parent := node.Parent
	offset := 0
	appendText := func(value string) {
		if value != "" {
			parent.InsertBefore(&html.Node{Type: html.TextNode, Data: value}, node)
		}
	}
	for _, match := range matches {
		appendText(node.Data[offset:match[0]])
		marker, suffix := trimMarkerPunctuation(node.Data[match[0]:match[1]])
		if strings.HasPrefix(marker, "img://") {
			src := "https://" + strings.TrimPrefix(marker, "img://")
			if parsed, err := url.Parse(src); err == nil && parsed.Hostname() != "" {
				parent.InsertBefore(&html.Node{Type: html.ElementNode, Data: "img", Attr: []html.Attribute{{Key: "src", Val: parsed.String()}}}, node)
			} else {
				appendText(marker)
			}
		} else if parsed, err := url.Parse(marker); err == nil && parsed.Hostname() != "" {
			link := &html.Node{Type: html.ElementNode, Data: "a", Attr: []html.Attribute{{Key: "href", Val: parsed.String()}}}
			link.AppendChild(&html.Node{Type: html.TextNode, Data: marker})
			parent.InsertBefore(link, node)
		} else {
			appendText(marker)
		}
		appendText(suffix)
		offset = match[1]
	}
	appendText(node.Data[offset:])
	parent.RemoveChild(node)
}

func trimMarkerPunctuation(marker string) (string, string) {
	index := len(marker)
	for index > 0 && strings.ContainsRune(".,;!", rune(marker[index-1])) {
		index--
	}
	return marker[:index], marker[index:]
}

func extractThumbnailURL(html, sourceURL string) string {
	document, err := goquery.NewDocumentFromReader(strings.NewReader(html))
	if err != nil {
		return ""
	}
	base, _ := url.Parse(sourceURL)
	var thumbnail string
	document.Find("img").EachWithBreak(func(_ int, image *goquery.Selection) bool {
		src := strings.TrimSpace(image.AttrOr("src", ""))
		candidate, err := url.Parse(src)
		if src == "" || err != nil {
			return true
		}
		if !candidate.IsAbs() && base != nil {
			candidate = base.ResolveReference(candidate)
		}
		if candidate.Scheme != "http" && candidate.Scheme != "https" {
			return true
		}
		thumbnail = candidate.String()
		return false
	})
	return thumbnail
}
func sanitize(x string, baseURLs ...string) string {
	baseURL := ""
	if len(baseURLs) > 0 {
		baseURL = baseURLs[0]
	}
	x = normalizeCodeLanguageClasses(x)
	x = filterArticleRichContent(x, baseURL)
	p := bluemonday.NewPolicy()
	p.AllowElements("h1", "h2", "h3", "h4", "h5", "h6", "p", "br", "ul", "ol", "li", "blockquote", "table", "thead", "tbody", "tfoot", "tr", "th", "td", "figure", "figcaption", "pre", "code", "kbd", "samp", "strong", "b", "em", "i", "u", "mark", "del", "s", "a", "img", "video", "audio", "source", "iframe", "feedmind-math", "svg", "g", "defs", "symbol", "title", "desc", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "lineargradient", "radialgradient", "stop", "pattern", "clippath", "mask", "marker", "filter", "fegaussianblur", "feoffset", "feblend", "fecolormatrix", "use", "hr", "sup", "sub")
	p.AllowAttrs("href", "title").OnElements("a")
	p.AllowAttrs("src", "alt", "title", "width", "height").OnElements("img")
	p.AllowAttrs("src", "poster", "width", "height").OnElements("video")
	p.AllowAttrs("src").OnElements("audio")
	p.AllowAttrs("src", "type").OnElements("source")
	p.AllowAttrs("src", "title", "width", "height").OnElements("iframe")
	p.AllowAttrs("data-format", "data-display").OnElements("feedmind-math")
	p.AllowAttrs("colspan", "rowspan").OnElements("th", "td")
	p.AllowAttrs("id", "viewbox", "width", "height", "x", "y", "x1", "x2", "y1", "y2", "cx", "cy", "r", "rx", "ry", "d", "points", "fill", "fill-opacity", "fill-rule", "stroke", "stroke-width", "stroke-opacity", "stroke-linecap", "stroke-linejoin", "stroke-dasharray", "opacity", "transform", "gradientunits", "gradienttransform", "offset", "stop-color", "stop-opacity", "patternunits", "patterntransform", "preserveaspectratio", "clip-path", "clip-rule", "mask", "marker-start", "marker-mid", "marker-end", "filter", "stddeviation", "dx", "dy", "in", "in2", "result", "values", "font-family", "font-size", "font-weight", "text-anchor", "dominant-baseline", "role", "aria-label", "xmlns").OnElements("svg", "g", "defs", "symbol", "title", "desc", "path", "rect", "circle", "ellipse", "line", "polyline", "polygon", "text", "tspan", "lineargradient", "radialgradient", "stop", "pattern", "clippath", "mask", "marker", "filter", "fegaussianblur", "feoffset", "feblend", "fecolormatrix", "use")
	p.AllowAttrs("href").Matching(regexp.MustCompile(`^#[A-Za-z_][A-Za-z0-9_.:-]*$`)).OnElements("use")
	p.AllowAttrs("class").Matching(regexp.MustCompile(`^(?:language|lang)-[A-Za-z0-9_+#.-]+$`)).OnElements("code")
	p.AllowURLSchemes("http", "https")
	p.RequireNoFollowOnLinks(true)
	return p.Sanitize(x)
}

var videoEmbedHosts = []string{
	"youtube.com",
	"youtube-nocookie.com",
	"youtu.be",
	"player.vimeo.com",
	"player.bilibili.com",
	"player.youku.com",
	"v.qq.com",
	"dailymotion.com",
	"dai.ly",
}

func isVideoEmbedURL(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	if err != nil || (parsed.Scheme != "http" && parsed.Scheme != "https") {
		return false
	}
	hostname := strings.ToLower(parsed.Hostname())
	for _, allowed := range videoEmbedHosts {
		if hostname == allowed || strings.HasSuffix(hostname, "."+allowed) {
			return true
		}
	}
	return false
}

func isSafeIframeURL(value string) bool {
	parsed, err := url.Parse(strings.TrimSpace(value))
	return err == nil && (parsed.Scheme == "https" || isVideoEmbedURL(value))
}

func resolveRichContentURL(value, baseURL string) string {
	value = strings.TrimSpace(value)
	if value == "" {
		return ""
	}
	if strings.HasPrefix(value, "//") {
		value = "https:" + value
	}
	candidate, err := url.Parse(value)
	if err != nil {
		return ""
	}
	if !candidate.IsAbs() && baseURL != "" {
		if base, baseErr := url.Parse(baseURL); baseErr == nil {
			candidate = base.ResolveReference(candidate)
		}
	}
	if candidate.Scheme != "http" && candidate.Scheme != "https" {
		return ""
	}
	return candidate.String()
}

var safeMathMLTags = map[string]bool{"math": true, "mrow": true, "mi": true, "mn": true, "mo": true, "mtext": true, "mspace": true, "ms": true, "mglyph": true, "mfrac": true, "msqrt": true, "mroot": true, "mstyle": true, "merror": true, "mpadded": true, "mphantom": true, "mfenced": true, "menclose": true, "msub": true, "msup": true, "msubsup": true, "munder": true, "mover": true, "munderover": true, "mmultiscripts": true, "mprescripts": true, "none": true, "mtable": true, "mtr": true, "mtd": true, "maligngroup": true, "malignmark": true, "semantics": true, "annotation": true}
var safeMathMLAttrs = map[string]bool{"display": true, "xmlns": true, "mathvariant": true, "mathsize": true, "mathcolor": true, "mathbackground": true, "displaystyle": true, "scriptlevel": true, "stretchy": true, "symmetric": true, "fence": true, "separator": true, "lspace": true, "rspace": true, "minsize": true, "maxsize": true, "accent": true, "accentunder": true, "align": true, "columnalign": true, "rowalign": true, "columnspan": true, "rowspan": true, "encoding": true}

func cloneSafeMathML(node *html.Node) *html.Node {
	if node.Type == html.TextNode {
		return &html.Node{Type: html.TextNode, Data: node.Data}
	}
	if node.Type != html.ElementNode || !safeMathMLTags[strings.ToLower(node.Data)] {
		return nil
	}
	clone := &html.Node{Type: html.ElementNode, Data: strings.ToLower(node.Data)}
	for _, attr := range node.Attr {
		key := strings.ToLower(attr.Key)
		if safeMathMLAttrs[key] && !strings.Contains(strings.ToLower(attr.Val), "javascript:") && !strings.Contains(strings.ToLower(attr.Val), "data:") {
			clone.Attr = append(clone.Attr, html.Attribute{Key: key, Val: attr.Val})
		}
	}
	for child := node.FirstChild; child != nil; child = child.NextSibling {
		if safe := cloneSafeMathML(child); safe != nil {
			clone.AppendChild(safe)
		}
	}
	return clone
}

func renderNode(node *html.Node) string {
	var output strings.Builder
	if node != nil && html.Render(&output, node) == nil {
		return output.String()
	}
	return ""
}

func elementAttr(node *html.Node, key string) string {
	for _, attr := range node.Attr {
		if strings.EqualFold(attr.Key, key) {
			return strings.TrimSpace(attr.Val)
		}
	}
	return ""
}

func trimTexFormulaDelimiters(source string) (string, bool) {
	source = strings.TrimSpace(source)
	for _, delimiter := range [][2]string{{`\[`, `\]`}, {`\(`, `\)`}, {`$$`, `$$`}} {
		if strings.HasPrefix(source, delimiter[0]) && strings.HasSuffix(source, delimiter[1]) {
			return strings.TrimSpace(source[len(delimiter[0]) : len(source)-len(delimiter[1])]), delimiter[0] != `\(`
		}
	}
	return source, false
}

func normalizeArticleFormulas(root *html.Node) {
	var visit func(*html.Node)
	visit = func(node *html.Node) {
		for child := node.FirstChild; child != nil; {
			next := child.NextSibling
			visit(child)
			child = next
		}
		if node.Type != html.ElementNode || node.Parent == nil {
			return
		}
		tag := strings.ToLower(node.Data)
		format, display, source := "", false, ""
		if tag == "math" {
			format = "mathml"
			safe := cloneSafeMathML(node)
			source = renderNode(safe)
			for _, attr := range node.Attr {
				if strings.EqualFold(attr.Key, "display") && attr.Val == "block" {
					display = true
				}
			}
		} else if tag == "script" {
			typeValue := ""
			for _, attr := range node.Attr {
				if strings.EqualFold(attr.Key, "type") {
					typeValue = strings.ToLower(strings.TrimSpace(attr.Val))
				}
			}
			if typeValue != "math/tex" && typeValue != "math/tex; mode=display" {
				return
			}
			format, display = "tex", strings.Contains(typeValue, "mode=display")
			for child := node.FirstChild; child != nil; child = child.NextSibling {
				source += child.Data
			}
		} else if tag == "object" {
			className := strings.ToLower(elementAttr(node, "class"))
			dataURL := strings.ToLower(elementAttr(node, "data"))
			mediaType := strings.ToLower(elementAttr(node, "type"))
			isLatexSVG := mediaType == "image/svg+xml" && (strings.Contains(" "+className+" ", " latex-math ") || (strings.Contains(dataURL, "/images/math/") && strings.HasSuffix(strings.Split(dataURL, "?")[0], ".svg")))
			if !isLatexSVG {
				return
			}
			format = "tex"
			display = strings.Contains(" "+className+" ", " align-center ")
			for child := node.FirstChild; child != nil; child = child.NextSibling {
				source += child.Data
			}
			var delimitedDisplay bool
			source, delimitedDisplay = trimTexFormulaDelimiters(source)
			display = display || delimitedDisplay
		} else {
			return
		}
		if strings.TrimSpace(source) == "" {
			node.Parent.RemoveChild(node)
			return
		}
		formula := &html.Node{Type: html.ElementNode, Data: "feedmind-math", Attr: []html.Attribute{{Key: "data-format", Val: format}, {Key: "data-display", Val: map[bool]string{true: "block", false: "inline"}[display]}}}
		formula.AppendChild(&html.Node{Type: html.TextNode, Data: strings.TrimSpace(source)})
		node.Parent.InsertBefore(formula, node)
		node.Parent.RemoveChild(node)
	}
	visit(root)
}

func filterArticleRichContent(x, baseURL string) string {
	document, err := goquery.NewDocumentFromReader(strings.NewReader(x))
	if err != nil {
		return x
	}
	body := document.Find("body").First()
	if body.Length() == 0 {
		return x
	}
	normalizeArticleFormulas(body.Get(0))
	for _, selector := range []string{"img", "video", "audio", "source"} {
		document.Find(selector).Each(func(_ int, item *goquery.Selection) {
			src := resolveRichContentURL(item.AttrOr("src", item.AttrOr("data-src", "")), baseURL)
			if src != "" {
				item.SetAttr("src", src)
			} else {
				item.RemoveAttr("src")
			}
		})
	}
	document.Find("video").Each(func(_ int, video *goquery.Selection) {
		poster := resolveRichContentURL(video.AttrOr("poster", video.AttrOr("data-poster", "")), baseURL)
		if poster != "" {
			video.SetAttr("poster", poster)
		} else {
			video.RemoveAttr("poster")
		}
	})
	document.Find("source").Each(func(_ int, source *goquery.Selection) {
		if source.AttrOr("src", "") == "" || source.ParentsFiltered("audio,video").Length() == 0 {
			source.Remove()
		}
	})
	document.Find("video,audio").Each(func(_ int, media *goquery.Selection) {
		if media.AttrOr("src", "") == "" && media.Find("source").Length() == 0 {
			media.Remove()
		}
	})
	document.Find("iframe").Each(func(_ int, frame *goquery.Selection) {
		src := resolveRichContentURL(frame.AttrOr("src", frame.AttrOr("data-src", "")), baseURL)
		if !isSafeIframeURL(src) {
			frame.Remove()
			return
		}
		frame.SetAttr("src", src)
	})
	dangerousSVGValue := regexp.MustCompile(`(?i)(?:javascript|data):|url\s*\(\s*[^#]`)
	document.Find("svg").Each(func(_ int, svg *goquery.Selection) {
		check := func(element *goquery.Selection) {
			for _, node := range element.Nodes {
				for _, attr := range append([]html.Attribute(nil), node.Attr...) {
					key := strings.ToLower(attr.Key)
					if strings.HasPrefix(key, "on") || dangerousSVGValue.MatchString(attr.Val) || (key == "href" && !strings.HasPrefix(strings.TrimSpace(attr.Val), "#")) {
						element.RemoveAttr(attr.Key)
					}
				}
			}
		}
		check(svg)
		svg.Find("*").Each(func(_ int, child *goquery.Selection) { check(child) })
	})
	filtered, err := body.Html()
	if err != nil {
		return x
	}
	return filtered
}

// normalizeCodeLanguageClasses keeps the semantic language marker while
// dropping presentation classes such as hljs before the sanitizer validates
// the complete class attribute.
func normalizeCodeLanguageClasses(x string) string {
	document, err := goquery.NewDocumentFromReader(strings.NewReader(x))
	if err != nil {
		return x
	}
	languageClassPattern := regexp.MustCompile(`(?i)^(?:language|lang)-[A-Za-z0-9_+#.-]+$`)
	languageClassOf := func(selection *goquery.Selection) string {
		for _, className := range strings.Fields(selection.AttrOr(`class`, ``)) {
			if languageClassPattern.MatchString(className) {
				return className
			}
		}
		return ``
	}
	document.Find(`pre`).Each(func(_ int, pre *goquery.Selection) {
		languageClass := languageClassOf(pre)
		code := pre.Find(`code`).First()
		if languageClass != `` && code.Length() > 0 && languageClassOf(code) == `` {
			code.SetAttr(`class`, languageClass)
		}
	})
	document.Find(`code`).Each(func(_ int, code *goquery.Selection) {
		languageClass := languageClassOf(code)
		if languageClass == `` {
			code.RemoveAttr(`class`)
		} else {
			code.SetAttr(`class`, languageClass)
		}
	})
	body := document.Find(`body`).First()
	if body.Length() == 0 {
		return x
	}
	normalized, err := body.Html()
	if err != nil {
		return x
	}
	return normalized
}
