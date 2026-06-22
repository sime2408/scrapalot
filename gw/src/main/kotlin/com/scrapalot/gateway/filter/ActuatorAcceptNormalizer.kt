package com.scrapalot.gateway.filter

import org.springframework.core.Ordered
import org.springframework.core.annotation.Order
import org.springframework.http.HttpHeaders
import org.springframework.http.MediaType
import org.springframework.stereotype.Component
import org.springframework.web.server.ServerWebExchange
import org.springframework.web.server.WebFilter
import org.springframework.web.server.WebFilterChain
import reactor.core.publisher.Mono

/**
 * Spring Boot Actuator's HealthEndpoint produces only its own JSON media types
 * (application/vnd.spring-boot.actuator.v3+json, application/json). Browser
 * tabs (Accept: text/html), curl `-H 'Accept: text/plain'` probes, and dumb
 * load balancers therefore receive 406 NOT_ACCEPTABLE — which then floods the
 * gateway error log.
 *
 * Actuator handler mappings have higher precedence than Spring Cloud Gateway's
 * RoutePredicateHandlerMapping, so a YAML route filter cannot intercept the
 * request. A WebFilter runs before handler-mapping selection, which is the
 * correct interception point.
 */
@Component
@Order(Ordered.HIGHEST_PRECEDENCE)
class ActuatorAcceptNormalizer : WebFilter {

    override fun filter(exchange: ServerWebExchange, chain: WebFilterChain): Mono<Void> {
        val path = exchange.request.path.value()
        if (!path.startsWith("/actuator/")) {
            return chain.filter(exchange)
        }
        val mutated = exchange.request.mutate()
            .headers { headers -> headers.set(HttpHeaders.ACCEPT, MediaType.APPLICATION_JSON_VALUE) }
            .build()
        return chain.filter(exchange.mutate().request(mutated).build())
    }
}
