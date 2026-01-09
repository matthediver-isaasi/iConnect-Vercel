import { useState, useEffect } from 'react';
import { useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useToast } from '@/components/ui/use-toast';
import { Loader2, LogOut, Shield, Settings, Users, FileText } from 'lucide-react';
import RoleTemplatesEditor from './RoleTemplatesEditor';

export default function PlatformAdmin() {
  const navigate = useNavigate();
  const { toast } = useToast();
  const [owner, setOwner] = useState(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    checkSession();
  }, []);

  const checkSession = async () => {
    try {
      const response = await fetch('/api/platform/auth/session', {
        credentials: 'include'
      });
      const data = await response.json();

      if (!data.authenticated) {
        navigate('/platform/login');
        return;
      }

      setOwner(data.owner);
    } catch (error) {
      navigate('/platform/login');
    } finally {
      setLoading(false);
    }
  };

  const handleLogout = async () => {
    try {
      await fetch('/api/platform/auth/logout', {
        method: 'POST',
        credentials: 'include'
      });
      navigate('/platform/login');
    } catch (error) {
      toast({ title: 'Error', description: 'Logout failed', variant: 'destructive' });
    }
  };

  if (loading) {
    return (
      <div className="min-h-screen bg-background flex items-center justify-center">
        <Loader2 className="w-8 h-8 animate-spin text-muted-foreground" />
      </div>
    );
  }

  return (
    <div className="min-h-screen bg-background">
      <header className="border-b bg-card">
        <div className="container mx-auto px-4 py-4 flex items-center justify-between">
          <div className="flex items-center gap-3">
            <div className="w-10 h-10 bg-primary/10 rounded-full flex items-center justify-center">
              <Shield className="w-5 h-5 text-primary" />
            </div>
            <div>
              <h1 className="font-semibold">Platform Admin</h1>
              <p className="text-sm text-muted-foreground">{owner?.email}</p>
            </div>
          </div>
          <Button 
            variant="outline" 
            onClick={handleLogout}
            data-testid="button-logout"
          >
            <LogOut className="w-4 h-4 mr-2" />
            Logout
          </Button>
        </div>
      </header>

      <main className="container mx-auto px-4 py-8">
        <Tabs defaultValue="roles" className="space-y-6">
          <TabsList>
            <TabsTrigger value="roles" data-testid="tab-roles">
              <Users className="w-4 h-4 mr-2" />
              Default Roles
            </TabsTrigger>
            <TabsTrigger value="settings" data-testid="tab-settings">
              <Settings className="w-4 h-4 mr-2" />
              Provisioning
            </TabsTrigger>
          </TabsList>

          <TabsContent value="roles">
            <Card>
              <CardHeader>
                <CardTitle>Default Role Templates</CardTitle>
                <CardDescription>
                  Configure the roles that will be automatically created when a new tenant is provisioned.
                  These are independent templates - changes here won't affect existing tenants.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <RoleTemplatesEditor />
              </CardContent>
            </Card>
          </TabsContent>

          <TabsContent value="settings">
            <Card>
              <CardHeader>
                <CardTitle>Tenant Provisioning Settings</CardTitle>
                <CardDescription>
                  Configure default settings for new tenant creation.
                </CardDescription>
              </CardHeader>
              <CardContent>
                <p className="text-muted-foreground">
                  Provisioning settings will be added here in a future update.
                </p>
              </CardContent>
            </Card>
          </TabsContent>
        </Tabs>
      </main>
    </div>
  );
}
