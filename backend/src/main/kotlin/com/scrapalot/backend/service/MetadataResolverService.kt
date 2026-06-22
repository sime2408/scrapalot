package com.scrapalot.backend.service

import com.fasterxml.jackson.databind.JsonNode
import com.fasterxml.jackson.databind.ObjectMapper
import mu.KotlinLogging
import org.springframework.stereotype.Service
import org.springframework.web.client.RestClient
import org.springframework.web.client.body
import java.net.URI
import java.net.http.HttpClient
import java.net.http.HttpRequest
import java.net.http.HttpResponse

private val logger = KotlinLogging.logger {}

data class ResolvedMetadata(
    val title: String? = null,
    val authors: List<String> = emptyList(),
    val year: Int? = null,
    val journal: String? = null,
    val volume: String? = null,
    val issue: String? = null,
    val pages: String? = null,
    val abstract: String? = null,
    val doi: String? = null,
    val isbn: String? = null,
    val pmid: String? = null,
    val arxivId: String? = null,
    val url: String? = null,
    val publisher: String? = null,
    val documentType: String? = null,
    val source: String = "unknown",
    val confidence: Double = 0.0,
)

data class IdentifierDetection(
    val type: String, // "doi", "isbn", "arxiv", "pmid"
    val value: String, // cleaned identifier value
)

@Service
class MetadataResolverService(
    private val objectMapper: ObjectMapper,
) {
    private val restClient =
        RestClient
            .builder()
            .defaultHeader("User-Agent", "Scrapalot/1.0 (mailto:research@mail.scrapalot.app)")
            .build()

    /**
     * Detect identifier type from raw user input.
     */
    fun detectIdentifier(input: String): IdentifierDetection? {
        val text = input.trim()

        // DOI (with or without URL prefix)
        val doiMatch = Regex("""^(?:https?://(?:dx\.)?doi\.org/)?(?<id>10\.\d{4,}/\S+)$""").find(text)
        if (doiMatch != null) return IdentifierDetection("doi", requireNotNull(doiMatch.groups["id"]) { "DOI group 'id' not found" }.value)

        // arXiv (with or without URL/prefix)
        val arxivMatch = Regex("""^(?:https?://arxiv\.org/abs/)?(?:arXiv:)?(?<id>\d{4}\.\d{4,5}(?:v\d+)?)$""", RegexOption.IGNORE_CASE).find(text)
        if (arxivMatch != null) return IdentifierDetection("arxiv", requireNotNull(arxivMatch.groups["id"]) { "arXiv group 'id' not found" }.value)

        // ISBN (strip non-digits, validate length)
        val isbnCandidate = text.replace(Regex("[^0-9Xx]"), "").uppercase()
        if (isbnCandidate.length == 13 && isbnCandidate.startsWith("978") || isbnCandidate.startsWith("979")) {
            return IdentifierDetection("isbn", isbnCandidate)
        }
        if (isbnCandidate.length == 10) {
            return IdentifierDetection("isbn", isbnCandidate)
        }

        // PMID
        val pmidMatch = Regex("""^(?:PMID[:\s]*)?(\d{6,9})$""", RegexOption.IGNORE_CASE).find(text)
        if (pmidMatch != null) return IdentifierDetection("pmid", pmidMatch.groupValues[1])

        return null
    }

    /**
     * Resolve identifier to full metadata.
     */
    fun resolve(
        type: String,
        value: String
    ): ResolvedMetadata? =
        when (type) {
            "doi" -> resolveDoi(value)
            "isbn" -> resolveIsbn(value)
            "arxiv" -> resolveArxiv(value)
            "pmid" -> resolvePmid(value)
            else -> null
        }

    private fun resolveDoi(doi: String): ResolvedMetadata? =
        try {
            val response =
                restClient
                    .get()
                    .uri("https://api.crossref.org/works/{doi}", doi)
                    .header("Accept", "application/json")
                    .retrieve()
                    .body<String>()

            val root = objectMapper.readTree(response)
            val msg = root.path("message")

            val titleArr = msg.path("title")
            val title = if (titleArr.isArray && titleArr.size() > 0) titleArr[0].asText() else null

            val authors =
                msg.path("author").mapNotNull { a ->
                    val family = a.path("family").asText("")
                    val given = a.path("given").asText("")
                    if (family.isNotBlank()) "$family, $given".trimEnd(',', ' ') else null
                }

            val containerTitle = msg.path("container-title")
            val journal = if (containerTitle.isArray && containerTitle.size() > 0) containerTitle[0].asText() else null

            val year =
                extractYear(msg.path("published-print"))
                    ?: extractYear(msg.path("published-online"))
                    ?: extractYear(msg.path("created"))

            ResolvedMetadata(
                title = title,
                authors = authors,
                year = year,
                journal = journal,
                volume = msg.path("volume").asText(null),
                issue = msg.path("issue").asText(null),
                pages = msg.path("page").asText(null),
                abstract = cleanAbstract(msg.path("abstract").asText(null)),
                doi = doi,
                url = "https://doi.org/$doi",
                publisher = msg.path("publisher").asText(null),
                documentType = mapCrossrefType(msg.path("type").asText(null)),
                source = "crossref",
                confidence = 0.95,
            )
        } catch (e: Exception) {
            logger.debug { "CrossRef resolution failed for DOI $doi: ${e.message}" }
            null
        }

    private fun resolveIsbn(isbn: String): ResolvedMetadata? {
        return try {
            // Use java.net.http.HttpClient which follows redirects (Open Library returns 302)
            val httpClient =
                HttpClient
                    .newBuilder()
                    .followRedirects(HttpClient.Redirect.NORMAL)
                    .build()
            val request =
                HttpRequest
                    .newBuilder()
                    .uri(URI.create("https://openlibrary.org/isbn/$isbn.json"))
                    .header("User-Agent", "Scrapalot/1.0 (mailto:research@mail.scrapalot.app)")
                    .GET()
                    .build()
            val httpResponse = httpClient.send(request, HttpResponse.BodyHandlers.ofString())
            if (httpResponse.statusCode() != 200) return null

            val data = objectMapper.readTree(httpResponse.body())
            val title = data.path("title").asText(null)
            val publishDate = data.path("publish_date").asText("")
            val yearMatch = Regex("""\b(19|20)\d{2}\b""").find(publishDate)

            val publishers = data.path("publishers")
            val publisher = if (publishers.isArray && publishers.size() > 0) publishers[0].asText() else null

            ResolvedMetadata(
                title = title,
                year = yearMatch?.value?.toIntOrNull(),
                isbn = isbn,
                publisher = publisher,
                pages = data.path("number_of_pages").asText(null),
                documentType = "book",
                url = "https://openlibrary.org/isbn/$isbn",
                source = "openlibrary",
                confidence = 0.85,
            )
        } catch (e: Exception) {
            logger.debug { "Open Library resolution failed for ISBN $isbn: ${e.message}" }
            null
        }
    }

    private fun resolveArxiv(arxivId: String): ResolvedMetadata? {
        return try {
            val response =
                restClient
                    .get()
                    .uri("https://export.arxiv.org/api/query?id_list={id}&max_results=1", arxivId)
                    .retrieve()
                    .body<String>() ?: return null

            val titles = Regex("""<title[^>]*>(.*?)</title>""", RegexOption.DOT_MATCHES_ALL).findAll(response).toList()
            val title = if (titles.size > 1) titles[1].groupValues[1].trim() else null

            val authors = Regex("""<name>(.*?)</name>""").findAll(response).map { it.groupValues[1] }.toList()

            val summaries = Regex("""<summary[^>]*>(.*?)</summary>""", RegexOption.DOT_MATCHES_ALL).findAll(response).toList()
            val abstract =
                summaries
                    .firstOrNull()
                    ?.groupValues
                    ?.get(1)
                    ?.trim()

            val published = Regex("""<published>(.*?)</published>""").find(response)?.groupValues?.get(1)
            val year = published?.take(4)?.toIntOrNull()

            ResolvedMetadata(
                title = title,
                authors = authors,
                year = year,
                abstract = abstract,
                arxivId = arxivId,
                url = "https://arxiv.org/abs/$arxivId",
                documentType = "preprint",
                source = "arxiv",
                confidence = 0.95,
            )
        } catch (e: Exception) {
            logger.debug { "arXiv resolution failed for $arxivId: ${e.message}" }
            null
        }
    }

    private fun resolvePmid(pmid: String): ResolvedMetadata? {
        return try {
            val response =
                restClient
                    .get()
                    .uri("https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esummary.fcgi?db=pubmed&id={id}&retmode=json", pmid)
                    .retrieve()
                    .body<String>()

            val root = objectMapper.readTree(response)
            val result = root.path("result").path(pmid)
            if (result.isMissingNode || result.has("error")) return null

            val authors = result.path("authors").mapNotNull { it.path("name").asText(null) }
            val pubdate = result.path("pubdate").asText("")
            val year = Regex("""\d{4}""").find(pubdate)?.value?.toIntOrNull()

            var doi: String? = null
            result.path("articleids").forEach { aid ->
                if (aid.path("idtype").asText() == "doi") doi = aid.path("value").asText(null)
            }

            ResolvedMetadata(
                title = result.path("title").asText(null),
                authors = authors,
                year = year,
                journal = result.path("fulljournalname").asText(null) ?: result.path("source").asText(null),
                volume = result.path("volume").asText(null),
                issue = result.path("issue").asText(null),
                pages = result.path("pages").asText(null),
                doi = doi,
                pmid = pmid,
                url = "https://pubmed.ncbi.nlm.nih.gov/$pmid/",
                documentType = "journal_article",
                source = "pubmed",
                confidence = 0.90,
            )
        } catch (e: Exception) {
            logger.debug { "PubMed resolution failed for PMID $pmid: ${e.message}" }
            null
        }
    }

    private fun extractYear(dateNode: JsonNode): Int? {
        if (dateNode.isMissingNode) return null
        val parts = dateNode.path("date-parts")
        if (parts.isArray && parts.size() > 0 && parts[0].isArray && parts[0].size() > 0) {
            return parts[0][0].asInt()
        }
        return null
    }

    private fun cleanAbstract(raw: String?): String? {
        if (raw == null) return null
        val clean = raw.replace(Regex("<[^>]+>"), "").trim()
        return if (clean.length > 20) clean else null
    }

    private fun mapCrossrefType(type: String?): String? =
        when (type) {
            "journal-article" -> "journal_article"
            "book" -> "book"
            "book-chapter" -> "book_section"
            "proceedings-article" -> "conference_paper"
            "posted-content" -> "preprint"
            "dissertation" -> "thesis"
            else -> null
        }
}
