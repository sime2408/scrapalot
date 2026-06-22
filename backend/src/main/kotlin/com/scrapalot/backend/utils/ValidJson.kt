package com.scrapalot.backend.utils

import com.fasterxml.jackson.databind.ObjectMapper
import jakarta.validation.Constraint
import jakarta.validation.ConstraintValidator
import jakarta.validation.ConstraintValidatorContext
import jakarta.validation.Payload
import kotlin.reflect.KClass

@Target(AnnotationTarget.FIELD, AnnotationTarget.VALUE_PARAMETER)
@Retention(AnnotationRetention.RUNTIME)
@Constraint(validatedBy = [JsonStringValidator::class])
annotation class ValidJson(
    val message: String = "Must be valid JSON",
    val groups: Array<KClass<*>> = [],
    val payload: Array<KClass<out Payload>> = []
)

class JsonStringValidator : ConstraintValidator<ValidJson, String?> {
    private val objectMapper = ObjectMapper()

    override fun isValid(
        value: String?,
        context: ConstraintValidatorContext
    ): Boolean {
        if (value.isNullOrBlank()) return true
        return try {
            objectMapper.readTree(value)
            true
        } catch (_: Exception) {
            false
        }
    }
}
