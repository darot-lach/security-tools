# Minimal, version-pinned build images for CLI recon tools that don't publish an
# actively-maintained, author-official Docker Hub image (unlike ProjectDiscovery's
# httpx/katana/nuclei, which do -- those stay as prebuilt `image:` pulls in
# docker-compose.yml). Building from a pinned `go install ...@<tag>` keeps these on
# the same "exact pinned artifact, no floating tag" footing as every other tool here.
#
# Verify these before relying on results for a real assessment:
#   gau:         https://github.com/lc/gau/releases
#   waybackurls: https://github.com/tomnomnom/waybackurls/commits/master
#                (no semver release tags exist for this tool -- pin an exact commit
#                SHA instead of a floating branch ref like @latest/@master)
#   ffuf:        https://github.com/ffuf/ffuf/releases

FROM golang:1.23-alpine AS gau-build
RUN apk add --no-cache git
RUN go install github.com/lc/gau/v2/cmd/gau@v2.2.4
FROM alpine:3.20 AS gau
RUN apk add --no-cache ca-certificates
COPY --from=gau-build /go/bin/gau /usr/local/bin/gau
ENTRYPOINT ["gau"]

FROM golang:1.23-alpine AS waybackurls-build
RUN apk add --no-cache git
RUN go install github.com/tomnomnom/waybackurls@8d27cf3e3031de01179e8ba9127e968eb01008e9
FROM alpine:3.20 AS waybackurls
RUN apk add --no-cache ca-certificates
COPY --from=waybackurls-build /go/bin/waybackurls /usr/local/bin/waybackurls
ENTRYPOINT ["waybackurls"]

FROM golang:1.23-alpine AS ffuf-build
RUN apk add --no-cache git
RUN go install github.com/ffuf/ffuf/v2@v2.2.1
FROM alpine:3.20 AS ffuf
COPY --from=ffuf-build /go/bin/ffuf /usr/local/bin/ffuf
ENTRYPOINT ["ffuf"]
