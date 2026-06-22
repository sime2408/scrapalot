package com.scrapalot.backend.utils

import org.springframework.transaction.support.TransactionSynchronization
import org.springframework.transaction.support.TransactionSynchronizationManager

/**
 * Registers an action to run after the current transaction commits.
 * Falls back to immediate execution if no transaction is active.
 */
fun runAfterCommit(action: () -> Unit) {
    if (TransactionSynchronizationManager.isSynchronizationActive()) {
        TransactionSynchronizationManager.registerSynchronization(
            object : TransactionSynchronization {
                override fun afterCommit() {
                    action()
                }
            }
        )
    } else {
        action()
    }
}
