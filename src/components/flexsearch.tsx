import FlexSearch from "flexsearch";
import { useRouter } from "next/router";
import type { ReactElement, ReactNode } from "react";
import { useCallback, useState } from "react";
import { DEFAULT_LOCALE } from "../constants";
import type { SearchResult } from "../types";
import { HighlightMatches } from "./highlight-matches";
import { Search } from "./search";
import { fr } from "@codegouvfr/react-dsfr";
import { useStyles } from "tss-react/dsfr";

type SectionIndex = FlexSearch.Document<
    {
        id: string;
        url: string;
        title: string;
        pageId: string;
        content: string;
        display?: string;
    },
    ["title", "content", "url", "display"]
>;

type PageIndex = FlexSearch.Document<
    {
        id: number;
        title: string;
        content: string;
    },
    ["title"]
>;

type Result = {
    _page_rk: number;
    _section_rk: number;
    route: string;
    prefix: ReactNode;
    children: ReactNode;
};

type NextraData = {
    [route: string]: {
        title: string;
        data: Record<string, string>;
    };
};

// This can be global for better caching.
const indexes: {
    [locale: string]: [PageIndex, SectionIndex];
} = {};

// Caches promises that load the index
const loadIndexesPromises = new Map<string, Promise<void>>();
const loadIndexes = (basePath: string, locale: string): Promise<void> => {
    const key = basePath + "@" + locale;
    if (loadIndexesPromises.has(key)) {
        return loadIndexesPromises.get(key)!;
    }
    const promise = loadIndexesImpl(basePath, locale);
    loadIndexesPromises.set(key, promise);
    return promise;
};

const loadIndexesImpl = async (basePath: string, locale: string): Promise<void> => {
    const response = await fetch(`${basePath}/_next/static/chunks/nextra-data-${locale}.json`);

    const data = (await response.json()) as NextraData;

    const pageIndex: PageIndex = new FlexSearch.Document({
        cache: 100,
        tokenize: "full",
        document: {
            id: "id",
            index: "content",
            store: ["title"]
        },
        context: {
            resolution: 9,
            depth: 2,
            bidirectional: true
        }
    });

    const sectionIndex: SectionIndex = new FlexSearch.Document({
        cache: 100,
        tokenize: "full",
        document: {
            id: "id",
            index: "content",
            tag: "pageId",
            store: ["title", "content", "url", "display"]
        },
        context: {
            resolution: 9,
            depth: 2,
            bidirectional: true
        }
    });

    let pageId = 0;
    for (const route in data) {
        let pageContent = "";
        ++pageId;

        for (const heading in data[route].data) {
            const [hash, text] = heading.split("#");
            const url = route + (hash ? "#" + hash : "");
            const title = text || data[route].title;

            const content = data[route].data[heading] || "";
            const paragraphs = content.split("\n").filter(Boolean);

            sectionIndex.add({
                id: url,
                url,
                title,
                pageId: `page_${pageId}`,
                content: title,
                ...(paragraphs[0] && { display: paragraphs[0] })
            });

            for (let i = 0; i < paragraphs.length; i++) {
                sectionIndex.add({
                    id: `${url}_${i}`,
                    url,
                    title,
                    pageId: `page_${pageId}`,
                    content: paragraphs[i]
                });
            }

            // Add the page itself.
            pageContent += ` ${title} ${content}`;
        }

        pageIndex.add({
            id: pageId,
            title: data[route].title,
            content: pageContent
        });
    }

    indexes[locale] = [pageIndex, sectionIndex];
};

export function Flexsearch({ className }: { className?: string }): ReactElement {
    const { locale = DEFAULT_LOCALE, basePath } = useRouter();
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState(false);
    const [results, setResults] = useState<SearchResult[]>([]);
    const [search, setSearch] = useState("");

    const { css, cx } = useStyles();

    const doSearch = (search: string) => {
        if (!search) return;

        const [pageIndex, sectionIndex] = indexes[locale];

        // Show the results for the top 5 pages
        const pageResults =
            pageIndex.search<true>(search, 5, {
                enrich: true,
                suggest: true
            })[0]?.result || [];

        const results: Result[] = [];
        const pageTitleMatches: Record<number, number> = {};

        for (let i = 0; i < pageResults.length; i++) {
            const result = pageResults[i];
            pageTitleMatches[i] = 0;

            // Show the top 5 results for each page
            const sectionResults =
                sectionIndex.search<true>(search, 5, {
                    enrich: true,
                    suggest: true,
                    tag: `page_${result.id}`
                })[0]?.result || [];

            let isFirstItemOfPage = true;
            const occurred: Record<string, boolean> = {};

            for (let j = 0; j < sectionResults.length; j++) {
                const { doc } = sectionResults[j];
                const isMatchingTitle = doc.display !== undefined;
                if (isMatchingTitle) {
                    pageTitleMatches[i]++;
                }
                const { url, title } = doc;
                const content = doc.display || doc.content;
                if (occurred[url + "@" + content]) continue;
                occurred[url + "@" + content] = true;
                results.push({
                    _page_rk: i,
                    _section_rk: j,
                    route: url,
                    prefix: isFirstItemOfPage && result.doc.title,
                    children: (
                        <div>
                            <span
                                className={cx(
                                    fr.cx("fr-text--lead"),
                                    css({
                                        "display": "block",
                                        "marginBottom": fr.spacing("2v"),
                                        "marginTop": fr.spacing("1v")
                                    })
                                )}
                            >
                                <HighlightMatches match={search} value={title} />
                            </span>
                            {content && (
                                <span
                                    className={css({
                                        "display": "block",
                                        "marginBottom": fr.spacing("2v")
                                    })}
                                >
                                    <HighlightMatches match={search} value={content} />
                                </span>
                            )}
                        </div>
                    )
                });
                isFirstItemOfPage = false;
            }
        }

        setResults(
            results
                .sort((a, b) => {
                    // Sort by number of matches in the title.
                    if (a._page_rk === b._page_rk) {
                        return a._section_rk - b._section_rk;
                    }
                    if (pageTitleMatches[a._page_rk] !== pageTitleMatches[b._page_rk]) {
                        return pageTitleMatches[b._page_rk] - pageTitleMatches[a._page_rk];
                    }
                    return a._page_rk - b._page_rk;
                })
                .map(res => ({
                    id: `${res._page_rk}_${res._section_rk}`,
                    route: res.route,
                    prefix: res.prefix,
                    children: res.children
                }))
        );
    };

    const preload = useCallback(
        async (active: boolean) => {
            if (active && !indexes[locale]) {
                setLoading(true);
                try {
                    await loadIndexes(basePath, locale);
                } catch (e) {
                    setError(true);
                }
                setLoading(false);
            }
        },
        [locale, basePath]
    );

    const handleChange = async (value: string) => {
        setSearch(value);
        if (loading) {
            return;
        }
        if (!indexes[locale]) {
            setLoading(true);
            try {
                await loadIndexes(basePath, locale);
            } catch (e) {
                setError(true);
            }
            setLoading(false);
        }
        doSearch(value);
    };

    return (
        <Search
            loading={loading}
            error={error}
            value={search}
            onChange={handleChange}
            onActive={preload}
            className={className}
            results={results}
        />
    );
}
