package com.scrapalot.backend

import org.springframework.boot.autoconfigure.SpringBootApplication
import org.springframework.boot.autoconfigure.data.redis.RedisRepositoriesAutoConfiguration
import org.springframework.boot.context.properties.ConfigurationPropertiesScan
import org.springframework.boot.runApplication
import org.springframework.scheduling.annotation.EnableScheduling

@SpringBootApplication(exclude = [RedisRepositoriesAutoConfiguration::class])
@ConfigurationPropertiesScan
@EnableScheduling
class ScrapalotBackendApplication

fun main(args: Array<String>) {
    runApplication<ScrapalotBackendApplication>(*args)
}
