#!/bin/bash
# Scrapalot Chat Management Script
# Combines server initialization and Docker management

set -e

# Colors for output
RED='\033[0;31m'
GREEN='\033[0;32m'
YELLOW='\033[1;33m'
BLUE='\033[0;34m'
NC='\033[0m' # No Color

# Server configuration
SERVER_IP="46.224.25.110"

# Print functions
print_status() { echo -e "${BLUE}[INFO]${NC} $1"; }
print_success() { echo -e "${GREEN}[SUCCESS]${NC} $1"; }
print_warning() { echo -e "${YELLOW}[WARNING]${NC} $1"; }
print_error() { echo -e "${RED}[ERROR]${NC} $1"; }

# ============================================================================
# SECTION 1: SERVER INITIALIZATION
# ============================================================================

init_server() {
    echo "========================================="
    echo "Scrapalot Server Initialization"
    echo "========================================="
    echo ""

    print_status "Step 1: Updating system packages"
    sudo apt-get update
    sudo apt-get upgrade -y

    print_status "Step 2: Installing essential tools"
    sudo apt-get install -y \
        apt-transport-https ca-certificates curl gnupg lsb-release \
        software-properties-common git wget vim htop ufw

    print_status "Step 3: Installing Docker"
    # Remove old Docker installations
    sudo apt-get remove -y docker docker-engine docker.io containerd runc || true

    # Add Docker's official GPG key
    sudo mkdir -p /etc/apt/keyrings
    curl -fsSL https://download.docker.com/linux/ubuntu/gpg | sudo gpg --dearmor -o /etc/apt/keyrings/docker.gpg

    # Set up Docker repository
    echo \
      "deb [arch=$(dpkg --print-architecture) signed-by=/etc/apt/keyrings/docker.gpg] https://download.docker.com/linux/ubuntu \
      $(lsb_release -cs) stable" | sudo tee /etc/apt/sources.list.d/docker.list > /dev/null

    # Install Docker Engine
    sudo apt-get update
    sudo apt-get install -y docker-ce docker-ce-cli containerd.io docker-buildx-plugin docker-compose-plugin

    # Start and enable Docker
    sudo systemctl start docker
    sudo systemctl enable docker

    print_status "Step 4: Configuring Docker permissions"
    sudo usermod -aG docker $USER

    print_status "Step 5: Verifying Docker Compose V2"
    docker compose version

    print_status "Step 6: Configuring UFW Firewall"
    sudo ufw --force reset
    sudo ufw default deny incoming
    sudo ufw default allow outgoing
    sudo ufw allow 22/tcp    # SSH
    sudo ufw allow 80/tcp    # HTTP
    sudo ufw allow 443/tcp   # HTTPS
    sudo ufw allow 81/tcp    # Nginx Proxy Manager Admin
    sudo ufw allow 9000/tcp  # Portainer HTTP
    sudo ufw allow 9443/tcp  # Portainer HTTPS
    sudo ufw --force enable
    sudo ufw status

    print_warning "After initial setup, restrict management interface access:"
    echo "  sudo ufw delete allow 81"
    echo "  sudo ufw delete allow 9000"
    echo "  sudo ufw allow from YOUR_IP to any port 81"
    echo "  sudo ufw allow from YOUR_IP to any port 9000"

    print_status "Step 7: Creating deployment directory"
    sudo mkdir -p /opt/scrapalot
    sudo chown $USER:$USER /opt/scrapalot

    print_status "Step 8: Configuring Docker daemon"
    sudo mkdir -p /etc/docker
    cat <<EOF | sudo tee /etc/docker/daemon.json
{
  "log-driver": "json-file",
  "log-opts": {
    "max-size": "10m",
    "max-file": "3"
  },
  "default-address-pools": [
    {
      "base": "172.28.0.0/16",
      "size": 24
    }
  ]
}
EOF
    sudo systemctl restart docker

    print_status "Step 9: Setting up swap space"
    if [ ! -f /swapfile ]; then
        sudo fallocate -l 4G /swapfile
        sudo chmod 600 /swapfile
        sudo mkswap /swapfile
        sudo swapon /swapfile
        echo '/swapfile none swap sw 0 0' | sudo tee -a /etc/fstab
        print_success "Swap created and enabled"
    else
        print_status "Swap already exists"
    fi

    print_status "Step 10: Optimizing system parameters"
    cat <<EOF | sudo tee /etc/sysctl.d/99-scrapalot.conf
# Network optimizations
net.core.somaxconn = 1024
net.ipv4.tcp_max_syn_backlog = 2048
net.ipv4.ip_local_port_range = 10000 65000

# Memory optimizations
vm.swappiness = 10
vm.vfs_cache_pressure = 50

# File descriptor limits
fs.file-max = 100000
EOF
    sudo sysctl -p /etc/sysctl.d/99-scrapalot.conf

    print_status "Step 11: Creating log rotation for Docker containers"
    cat <<EOF | sudo tee /etc/logrotate.d/docker-containers
/var/lib/docker/containers/*/*.log {
  rotate 7
  daily
  compress
  size=10M
  missingok
  delaycompress
  copytruncate
}
EOF

    print_success "✓ Server initialization complete!"
    echo ""
    echo "========================================="
    echo "Next Steps:"
    echo "========================================="
    echo ""
    echo "1. Setup GitHub Actions Runner:"
    echo "   - Go to: https://github.com/sime2408/scrapalot-chat/settings/actions/runners/new"
    echo "   - Follow the instructions for Linux"
    echo ""
    echo "2. Add GitHub Secrets:"
    echo "   - Go to: https://github.com/sime2408/scrapalot-chat/settings/secrets/actions"
    echo "   - Add all required secrets (see .github/workflows/deploy-backend.yml)"
    echo ""
    echo "3. Deploy infrastructure services (ONE-TIME):"
    echo "   - Go to: https://github.com/sime2408/scrapalot-chat/actions"
    echo "   - Run 'Deploy Infrastructure Services' workflow"
    echo ""
    echo "4. Deploy the backend application:"
    echo "   - Run 'Deploy Backend' workflow from GitHub Actions"
    echo ""
    echo "5. Access management interfaces:"
    echo "   - Portainer: http://${SERVER_IP}:9000"
    echo "   - Nginx Proxy Manager: http://${SERVER_IP}:81"
    echo ""
    echo "========================================="
    print_error "IMPORTANT: Log out and log back in for Docker group changes to take effect!"
    echo "Run: ${YELLOW}su - $USER${NC} or logout and login again"
    echo "========================================="
}

# ============================================================================
# SECTION 2: DOCKER MANAGEMENT
# ============================================================================

show_help() {
    echo "Scrapalot Chat Management Script"
    echo ""
    echo "Usage: $0 [COMMAND] [OPTIONS]"
    echo ""
    echo "Commands:"
    echo "  init            Initialize server (install Docker, configure firewall, etc.)"
    echo "  up              Start services in local development mode (builds from source)"
    echo "  up-cloud        Start services in cloud mode (uses pre-built images)"
    echo "  up-workers      Start services with background workers"
    echo "  down            Stop all services"
    echo "  restart         Restart all services"
    echo "  logs            Show logs from all services"
    echo "  logs-app        Show application logs"
    echo "  logs-workers    Show worker logs"
    echo "  status          Show status of all services"
    echo "  build           Rebuild all images"
    echo "  build-vulkan    Build with Vulkan GPU support"
    echo "  clean           Clean up containers and volumes"
    echo ""
    echo "Examples:"
    echo "  $0 init                # Initialize new server"
    echo "  $0 up                  # Start in local development mode"
    echo "  $0 up-cloud            # Start in cloud mode (CI/CD)"
    echo "  $0 up-workers          # Start with background workers"
    echo "  $0 build-vulkan        # Build with GPU support"
    echo "  $0 logs-app            # Monitor application logs"
}

check_docker() {
    if ! docker info > /dev/null 2>&1; then
        print_error "Docker is not running. Please start Docker first."
        exit 1
    fi
}

check_env() {
    if [ ! -f ".env" ]; then
        print_warning ".env file not found. Creating from example.env..."
        cp example.env .env
        print_warning "Please edit .env file with your configuration before running again."
        exit 1
    fi
}

# Main command handling
case "${1:-}" in
    "init")
        init_server
        ;;

    "up")
        print_status "Starting Scrapalot Chat in local development mode..."
        check_docker
        check_env
        docker compose up -d --profile local
        print_success "Services started! Main app: http://localhost:8090"
        ;;

    "up-cloud")
        print_status "Starting Scrapalot Chat in cloud mode..."
        check_docker
        check_env
        # Cloud mode uses pre-built images (set via environment variables)
        docker compose up -d
        print_success "Cloud services started!"
        print_status "Access via Nginx Proxy Manager on ports 80/443"
        ;;

    "up-workers")
        print_status "Starting Scrapalot Chat with background workers..."
        check_docker
        check_env
        docker compose --profile workers up -d
        print_success "Services started with workers!"
        ;;

    "down")
        print_status "Stopping all services..."
        docker compose down
        print_success "All services stopped"
        ;;

    "restart")
        print_status "Restarting all services..."
        docker compose restart
        print_success "Services restarted"
        ;;

    "logs")
        print_status "Showing logs from all services..."
        docker compose logs -f
        ;;

    "logs-app")
        print_status "Showing application logs..."
        docker compose logs -f scrapalot-chat scrapalot-ui
        ;;

    "logs-workers")
        print_status "Showing worker logs..."
        docker compose logs -f scrapalot-primary scrapalot-docprocessing scrapalot-beat
        ;;

    "status")
        print_status "Service status:"
        docker compose ps
        ;;

    "build")
        print_status "Rebuilding all images..."
        docker compose build --no-cache
        print_success "Build completed"
        ;;

    "build-vulkan")
        print_status "Building with Vulkan GPU support..."
        docker build \
          --build-arg CMAKE_ARGS="-DLLAMA_VULKAN=ON" \
          -f Dockerfile \
          -t scrapalot-chat:latest ..
        print_success "Vulkan build completed"
        print_status "Set LLM_VULKAN_ENABLED=true and LLM_VULKAN_PREFER=true in .env to enable"
        ;;

    "clean")
        print_warning "This will remove all containers and volumes. Are you sure? (y/N)"
        read -r response
        if [[ "$response" =~ ^([yY][eE][sS]|[yY])$ ]]; then
            print_status "Cleaning up containers and volumes..."
            docker compose down -v
            docker system prune -f
            print_success "Cleanup completed"
        else
            print_status "Cleanup cancelled"
        fi
        ;;

    "help"|"-h"|"--help"|"")
        show_help
        ;;

    *)
        print_error "Unknown command: $1"
        echo ""
        show_help
        exit 1
        ;;
esac
