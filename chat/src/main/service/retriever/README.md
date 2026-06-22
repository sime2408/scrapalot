# RAG

## R2R + Ollama + Neo4j

### Ollama

```sh
# pull triplex
ollama pull sciphi/triplex

# pull embedding / RAG LLMs pick you prefer one here
ollama pull llama3
ollama pull mxbai-embed-large

# leave running in separate terminal if you don't have ollama running as a service
ollama serve
```

## Knowledge Graph

Knowledge Graph Provider — Neo4J and for knowledge extraction we use
triplex model serve by Ollama (ollama/sciphi/triplex).

```json
{
  "kg": {
    "provider": "neo4j",
    "batch_size": 1,
    "text_splitter": {
      "type": "recursive_character",
      "chunk_size": 1024,
      "chunk_overlap": 0
    },
    "kg_extraction_prompt": "zero_shot_ner_kg_extraction",
    "kg_extraction_config": {
      "model": "ollama/sciphi/triplex",
      "temperature": 0.1,
      "top_p": 1.0,
      "top_k": 100,
      "max_tokens_to_sample": 1024,
      "stream": false,
      "functions": null,
      "skip_special_tokens": false,
      "stop_token": null,
      "num_beams": 1,
      "do_sample": true,
      "generate_with_chat": false,
      "add_generation_kwargs": {},
      "api_base": null
    }
  }
}

```

### Run

```
r2r --config-name=configs/knowledge_graph serve --docker --docker-ext-neo4j
r2r ingest-files data.txt
r2r inspect-knowledge-graph
```

## Inference

### Inference

```
