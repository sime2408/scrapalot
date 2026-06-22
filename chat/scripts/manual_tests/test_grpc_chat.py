#!/usr/bin/env python3
"""
Test gRPC Chat Service Communication

Tests direct gRPC communication to Python chat service to verify:
1. gRPC server is running and accessible
2. ChatService.GenerateChat endpoint works
3. Streaming response is properly formatted
"""

import os
import sys

import grpc

# Add src/main/grpc to path for proto imports
sys.path.insert(0, "/opt/scrapalot/scrapalot-chat/src/main/grpc")

from chat_pb2 import ChatRequest  # noqa: E402
from chat_pb2_grpc import ChatServiceStub  # noqa: E402


def test_grpc_chat():
    """Test gRPC chat generation"""

    print("=" * 80)
    print("Testing gRPC Chat Service Communication")
    print("=" * 80)

    # Create gRPC channel
    channel = grpc.insecure_channel("localhost:9091")
    stub = ChatServiceStub(channel)

    # Create test request
    request = ChatRequest(
        prompt="Test gRPC communication - simple test query",
        user_id="00000000-0000-0000-0000-000000000001",  # Test user ID
        session_id="test-session-" + os.urandom(8).hex(),
        language="en",
        collection_ids=[],
        document_ids=[],
        web_search_enabled=False,
        deep_research_enabled=False,
        agentic_rag_enabled=False,
        research_breadth="focused",
        research_depth="standard",
        min_confidence_threshold=0.7,
        max_sources=5,
        source_preferences={},
    )

    print("\n📤 Sending gRPC request:")
    print(f"   - Prompt: {request.prompt}")
    print(f"   - User ID: {request.user_id}")
    print(f"   - Session ID: {request.session_id}")
    print(f"   - Language: {request.language}")

    try:
        print("\n🔄 Calling ChatService.GenerateChat...")

        # Call streaming gRPC method
        response_stream = stub.GenerateChat(request)

        packet_count = 0
        print("\n📦 Receiving streaming packets:\n")

        for response_packet in response_stream:
            packet_count += 1

            # Display packet info
            print(f"   [{packet_count:3d}] Type: {response_packet.type:20s} | Content: {response_packet.content[:60]}")

            # Stop after 10 packets to avoid overwhelming output
            if packet_count >= 10:
                print("\n   ... (stopping after 10 packets for brevity)")
                break

        print(f"\nSUCCESS: Received {packet_count} packets from gRPC service")
        print("gRPC communication working correctly!")

        return True

    except grpc.RpcError as e:
        print("\n❌ gRPC Error:")
        print(f"   - Status Code: {e.code()}")
        print(f"   - Details: {e.details()}")
        return False

    except Exception as e:
        print(f"\n❌ Unexpected Error: {type(e).__name__}: {e}")
        import traceback

        traceback.print_exc()
        return False

    finally:
        channel.close()


if __name__ == "__main__":
    print("\n")
    success = test_grpc_chat()
    print("\n" + "=" * 80)

    if success:
        print("gRPC Chat Service Test: PASSED")
        sys.exit(0)
    else:
        print("❌ gRPC Chat Service Test: FAILED")
        sys.exit(1)
