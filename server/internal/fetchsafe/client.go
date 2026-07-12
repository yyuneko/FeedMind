package fetchsafe

import (
	"context"
	"errors"
	"fmt"
	"io"
	"net"
	"net/http"
	"net/url"
	"strings"
	"time"
)

type Client struct {
	HTTP     *http.Client
	MaxBytes int64
}

func New() *Client {
	c := &Client{MaxBytes: 8 << 20}
	d := &net.Dialer{Timeout: 8 * time.Second, KeepAlive: 30 * time.Second}
	tr := &http.Transport{Proxy: http.ProxyFromEnvironment, DialContext: func(ctx context.Context, network, address string) (net.Conn, error) {
		host, port, e := net.SplitHostPort(address)
		if e != nil {
			return nil, e
		}
		ips, e := net.DefaultResolver.LookupIPAddr(ctx, host)
		if e != nil {
			return nil, e
		}
		for _, x := range ips {
			if blocked(x.IP) {
				return nil, fmt.Errorf("blocked upstream address")
			}
		}
		if len(ips) == 0 {
			return nil, errors.New("host has no addresses")
		}
		return d.DialContext(ctx, network, net.JoinHostPort(ips[0].IP.String(), port))
	}, TLSHandshakeTimeout: 8 * time.Second, ResponseHeaderTimeout: 12 * time.Second, MaxIdleConnsPerHost: 4}
	c.HTTP = &http.Client{Transport: tr, Timeout: 20 * time.Second, CheckRedirect: func(req *http.Request, via []*http.Request) error {
		if len(via) >= 5 {
			return errors.New("too many redirects")
		}
		return ValidateURL(req.Context(), req.URL)
	}}
	return c
}
func blocked(ip net.IP) bool {
	return ip.IsLoopback() || ip.IsPrivate() || ip.IsLinkLocalMulticast() || ip.IsLinkLocalUnicast() || ip.IsMulticast() || ip.IsUnspecified()
}
func ValidateURL(ctx context.Context, u *url.URL) error {
	if u == nil || (u.Scheme != "http" && u.Scheme != "https") || u.Hostname() == "" {
		return errors.New("only public http/https URLs are allowed")
	}
	ips, e := net.DefaultResolver.LookupIPAddr(ctx, u.Hostname())
	if e != nil {
		return e
	}
	for _, x := range ips {
		if blocked(x.IP) || strings.EqualFold(x.IP.String(), "169.254.169.254") {
			return errors.New("private or reserved destination is blocked")
		}
	}
	return nil
}
func (c *Client) Get(ctx context.Context, raw string, headers map[string]string) (*http.Response, []byte, error) {
	u, e := url.Parse(raw)
	if e != nil {
		return nil, nil, e
	}
	if e = ValidateURL(ctx, u); e != nil {
		return nil, nil, e
	}
	req, e := http.NewRequestWithContext(ctx, "GET", u.String(), nil)
	if e != nil {
		return nil, nil, e
	}
	req.Header.Set("User-Agent", "FeedMind/1.0 (+https://github.com/yyuneko/FeedMind)")
	req.Header.Set("Accept-Encoding", "identity")
	for k, v := range headers {
		if v != "" {
			req.Header.Set(k, v)
		}
	}
	resp, e := c.HTTP.Do(req)
	if e != nil {
		return nil, nil, e
	}
	body, e := io.ReadAll(io.LimitReader(resp.Body, c.MaxBytes+1))
	resp.Body.Close()
	if e != nil {
		return resp, nil, e
	}
	if int64(len(body)) > c.MaxBytes {
		return resp, nil, errors.New("upstream response is too large")
	}
	return resp, body, nil
}
