import { StreamPacket } from '@/types/streaming-packets';

export class PacketParser {
  /**
   * Parse a single line from the streaming response.
   * @param line - JSON string representing a packet
   * @returns Parsed packet or null if invalid
   */
  static parseLine(line: string): StreamPacket | null {
    if (!line.trim()) {
      return null;
    }

    try {
      const packet = JSON.parse(line) as StreamPacket;

      // Validate packet structure
      if (packet.ind === undefined || packet.ind === null) {
        console.warn('Packet missing index:', line);
        return null;
      }

      if (!packet.obj || !packet.obj.type) {
        console.warn('Packet missing obj or type:', line);
        return null;
      }

      return packet;
    } catch (error) {
      console.error('Failed to parse packet:', line, error);
      return null;
    }
  }

}
